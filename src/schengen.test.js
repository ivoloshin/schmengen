import { describe, it, expect } from 'vitest';
import {
    MS_PER_DAY, toUTC, addDays, diffDays, formatShortDate,
    calcUsage, calcSafe, getGapStats, getExpiringDays,
    getCalendarDays, getWeekStarts, getMonths,
} from './schengen.js';

// ---------------------------------------------------------------------------
// Test harness: a fixed anchor and day-offset helpers so every expected value
// is reproducible and hand-checkable. A = 2024-01-01 (UTC midnight).
// All trips are expressed as integer day offsets from the anchor.
// (Run with TZ=UTC — see package.json — so the toUTC tests are deterministic.)
// ---------------------------------------------------------------------------
const A = Date.UTC(2024, 0, 1);
const D = (n) => A + n * MS_PER_DAY;
const trip = (a, b) => ({ id: `${a}_${b}`, start: D(a), end: D(b) });

describe('diffDays — inclusive day delta, round-robust', () => {
    it('same day → 0', () => expect(diffDays(D(0), D(0))).toBe(0));
    it('+1 day', () => expect(diffDays(D(1), D(0))).toBe(1));
    it('-1 day (negative)', () => expect(diffDays(D(0), D(1))).toBe(-1));
    it('179-day span (the window radius)', () => expect(diffDays(D(0), D(-179))).toBe(179));
    it('negative offsets', () => expect(diffDays(D(-10), D(-40))).toBe(30));
    it('leap February (Feb 28 → Mar 1, 2024 = 2 days)', () =>
        expect(diffDays(Date.UTC(2024, 2, 1), Date.UTC(2024, 1, 28))).toBe(2));
    it('non-leap February (Feb 28 → Mar 1, 2023 = 1 day)', () =>
        expect(diffDays(Date.UTC(2023, 2, 1), Date.UTC(2023, 1, 28))).toBe(1));
    it('leap year length = 366', () =>
        expect(diffDays(Date.UTC(2025, 0, 1), Date.UTC(2024, 0, 1))).toBe(366));
    it('non-leap year length = 365', () =>
        expect(diffDays(Date.UTC(2024, 0, 1), Date.UTC(2023, 0, 1))).toBe(365));
    it('sub-day drift rounds down', () =>
        expect(diffDays(D(0) + 3_600_000, D(0))).toBe(0));
    it('half-day-plus rounds up', () =>
        expect(diffDays(D(0) + MS_PER_DAY / 2 + 1, D(0))).toBe(1));
});

describe('addDays — pure ms arithmetic across boundaries', () => {
    it('zero', () => expect(addDays(D(0), 0)).toBe(D(0)));
    it('+1', () => expect(addDays(D(0), 1)).toBe(D(1)));
    it('-1', () => expect(addDays(D(0), -1)).toBe(D(-1)));
    it('month rollover Jan 31 → Feb 1', () =>
        expect(addDays(Date.UTC(2024, 0, 31), 1)).toBe(Date.UTC(2024, 1, 1)));
    it('leap crossing Feb 28 → Feb 29', () =>
        expect(addDays(Date.UTC(2024, 1, 28), 1)).toBe(Date.UTC(2024, 1, 29)));
    it('leap crossing Feb 29 → Mar 1', () =>
        expect(addDays(Date.UTC(2024, 1, 29), 1)).toBe(Date.UTC(2024, 2, 1)));
    it('year crossing Dec 31 → Jan 1', () =>
        expect(addDays(Date.UTC(2024, 11, 31), 1)).toBe(Date.UTC(2025, 0, 1)));
    it('+365 days in a leap year lands on Dec 31', () =>
        expect(addDays(D(0), 365)).toBe(Date.UTC(2024, 11, 31)));
});

describe('toUTC — floors to UTC midnight using LOCAL calendar fields', () => {
    it('UTC midnight passes through', () =>
        expect(toUTC(new Date(Date.UTC(2024, 0, 1)))).toBe(A));
    it('strips the time component', () =>
        expect(toUTC(new Date(Date.UTC(2024, 0, 1, 13, 30)))).toBe(A));
    it('leap day', () =>
        expect(toUTC(new Date(Date.UTC(2024, 1, 29, 5)))).toBe(Date.UTC(2024, 1, 29)));
    it('year end', () =>
        expect(toUTC(new Date(Date.UTC(2024, 11, 31, 23, 59)))).toBe(Date.UTC(2024, 11, 31)));
    // Documents the intentional semantics: it reads the LOCAL calendar day, which is
    // what we want for "the user's today". A locally-constructed date round-trips by
    // its local Y/M/D regardless of runner TZ.
    it('captures the local calendar day (intentional)', () =>
        expect(toUTC(new Date(2024, 1, 29))).toBe(Date.UTC(2024, 1, 29)));
});

describe('formatShortDate — UTC-pinned display', () => {
    it('en-GB: "1 Jan"', () => expect(formatShortDate(A, 'en-GB')).toBe('1 Jan'));
    it('en-GB leap: "29 Feb"', () =>
        expect(formatShortDate(Date.UTC(2024, 1, 29), 'en-GB')).toBe('29 Feb'));
    it('no day-rollover at a late UTC hour (timeZone:UTC guard)', () =>
        expect(formatShortDate(Date.UTC(2024, 0, 1, 23, 0), 'en-GB')).toBe('1 Jan'));
    it('non-English locale renders the right day/month', () => {
        const out = formatShortDate(A, 'de-DE');
        // ICU strings vary by version; assert it matches the platform Intl output.
        expect(out).toBe(new Date(A).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', timeZone: 'UTC' }));
    });
});

describe('calcUsage — days of presence in the rolling 180-day window [target-179, target]', () => {
    it('no trips → 0', () => expect(calcUsage(D(0), [])).toBe(0));
    it('trip fully inside the window', () => expect(calcUsage(D(0), [trip(-10, -5)])).toBe(6));
    it('trip entirely before the window → 0', () => expect(calcUsage(D(0), [trip(-300, -250)])).toBe(0));
    it('trip entirely after the target → 0', () => expect(calcUsage(D(0), [trip(5, 10)])).toBe(0));
    it('trip straddling the left edge (clipped)', () => expect(calcUsage(D(0), [trip(-185, -175)])).toBe(5));
    it('trip starting exactly on the left edge', () => expect(calcUsage(D(0), [trip(-179, -170)])).toBe(10));
    it('single day one before the left edge → excluded', () => expect(calcUsage(D(0), [trip(-180, -180)])).toBe(0));
    it('single day exactly on the left edge → counted', () => expect(calcUsage(D(0), [trip(-179, -179)])).toBe(1));
    it('trip straddling the right edge (future part not counted)', () => expect(calcUsage(D(0), [trip(-5, 20)])).toBe(6));
    it('target inside a trip (entry day .. target inclusive)', () => expect(calcUsage(D(50), [trip(0, 200)])).toBe(51));
    it('exactly 90-day trip → 90', () => expect(calcUsage(D(89), [trip(0, 89)])).toBe(90));
    it('91-day trip → 91 (counter, not a gate)', () => expect(calcUsage(D(90), [trip(0, 90)])).toBe(91));
    it('trip filling the whole window → 180', () => expect(calcUsage(D(179), [trip(0, 179)])).toBe(180));
    it('over-long trip: window slides, still 180', () => expect(calcUsage(D(180), [trip(0, 180)])).toBe(180));
    it('multiple disjoint trips summed', () => expect(calcUsage(D(0), [trip(-170, -161), trip(-10, -1)])).toBe(20));
    it('multiple trips, one expired out of window', () => expect(calcUsage(D(0), [trip(-190, -181), trip(-10, -1)])).toBe(10));
    it('single-day trip', () => expect(calcUsage(D(0), [trip(-1, -1)])).toBe(1));
    it('leap day counts as one', () =>
        expect(calcUsage(Date.UTC(2024, 1, 29), [{ start: Date.UTC(2024, 1, 29), end: Date.UTC(2024, 1, 29) }])).toBe(1));
    it('negative target', () => expect(calcUsage(D(-3), [trip(-10, -5)])).toBe(6));
});

describe('calcSafe — max consecutive days (0..90) of a single forward stay from arrDate', () => {
    it('no trips → 90', () => expect(calcSafe(D(0), [])).toBe(90));
    it('arrival inside a trip → 0', () => expect(calcSafe(D(0), [trip(-5, 5)])).toBe(0));
    it('arrival on a trip start → 0', () => expect(calcSafe(D(0), [trip(0, 10)])).toBe(0));
    it('arrival on a trip end → 0', () => expect(calcSafe(D(0), [trip(-5, 0)])).toBe(0));
    it('recent 89-day past trip → 1', () => expect(calcSafe(D(0), [trip(-89, -1)])).toBe(1));
    it('recent 90-day past trip → 0', () => expect(calcSafe(D(0), [trip(-90, -1)])).toBe(0));
    it('recent 50-day past trip → 40', () => expect(calcSafe(D(0), [trip(-50, -1)])).toBe(40));
    it('future trip 30 days out → capped at 30', () => expect(calcSafe(D(0), [trip(30, 110)])).toBe(30));
    it('future trip 5 days out → capped at 5', () => expect(calcSafe(D(0), [trip(5, 200)])).toBe(5));
    it('far future trip (beyond the 90d horizon) → 90', () => expect(calcSafe(D(0), [trip(200, 260)])).toBe(90));
    it('past + future combination → bounded by past usage (50)', () =>
        expect(calcSafe(D(0), [trip(-40, -1), trip(60, 120)])).toBe(50));
    it('two future segments → stops at first overlap (40)', () =>
        expect(calcSafe(D(0), [trip(40, 50), trip(55, 200)])).toBe(40));
    it('leap arrival, no trips → 90', () => expect(calcSafe(Date.UTC(2024, 1, 29), [])).toBe(90));
});

describe('getGapStats — clear days since/until neighbouring trips (in-trip case fixed)', () => {
    it('no trips → {null, null}', () => expect(getGapStats(D(0), [])).toEqual({ since: null, until: null }));
    it('only a past trip', () => expect(getGapStats(D(0), [trip(-20, -10)])).toEqual({ since: 9, until: null }));
    it('only a future trip', () => expect(getGapStats(D(0), [trip(10, 20)])).toEqual({ since: null, until: 9 }));
    it('both neighbours', () => expect(getGapStats(D(0), [trip(-20, -10), trip(10, 20)])).toEqual({ since: 9, until: 9 }));
    it('trip ending the day before → 0 clear days (convention)', () =>
        expect(getGapStats(D(0), [trip(-5, -1)])).toEqual({ since: 0, until: null }));
    it('trip starting tomorrow → 0 clear days', () =>
        expect(getGapStats(D(0), [trip(1, 5)])).toEqual({ since: null, until: 0 }));
    it('one clear day before', () => expect(getGapStats(D(0), [trip(-2, -2)])).toEqual({ since: 1, until: null }));
    // Fixed behaviour: on/inside a trip the traveller is mid-trip → no gap.
    it('date on a trip end → in-trip (was buggy: reported 28 to a prior trip)', () =>
        expect(getGapStats(D(9), [trip(0, 9), trip(-30, -20)])).toEqual({ since: 0, until: 0, inTrip: true }));
    it('date on a trip start → in-trip', () =>
        expect(getGapStats(D(10), [trip(10, 20), trip(30, 40)])).toEqual({ since: 0, until: 0, inTrip: true }));
    it('date strictly inside a trip → in-trip', () =>
        expect(getGapStats(D(5), [trip(0, 9), trip(-30, -25), trip(20, 25)])).toEqual({ since: 0, until: 0, inTrip: true }));
    it('integration: analysisTrips-style split at checkDate is still detected as in-trip', () => {
        // Mirrors main.jsx analysisTrips: a trip strictly containing checkDate is split.
        const checkDate = D(5);
        const split = [{ start: D(0), end: checkDate }, { start: D(6), end: D(9) }];
        expect(getGapStats(checkDate, split)).toEqual({ since: 0, until: 0, inTrip: true });
    });
});

describe('getExpiringDays — used days dropping out of the window during the stay (0-length guarded)', () => {
    it('no past trips → 0', () => expect(getExpiringDays(D(0), 30, [trip(5, 10)])).toBe(0));
    it('past trip stays fully in window → 0', () => expect(getExpiringDays(D(0), 30, [trip(-10, -1)])).toBe(0));
    it('oldest 10-day block, 10-day stay → 9 expire', () => expect(getExpiringDays(D(0), 10, [trip(-179, -170)])).toBe(9));
    it('oldest 10-day block, 11-day stay → all 10 expire', () => expect(getExpiringDays(D(0), 11, [trip(-179, -170)])).toBe(10));
    it('partial 6-day block → 5 expire', () => expect(getExpiringDays(D(0), 10, [trip(-175, -170)])).toBe(5));
    it('single old day expires', () => expect(getExpiringDays(D(0), 10, [trip(-175, -175)])).toBe(1));
    it('single day not yet expiring → 0', () => expect(getExpiringDays(D(0), 10, [trip(-170, -170)])).toBe(0));
    it('1-day stay expires nothing', () => expect(getExpiringDays(D(0), 1, [trip(-179, -179)])).toBe(0));
    it('duration 0 → guarded to 0 (was spurious)', () => expect(getExpiringDays(D(0), 0, [trip(-179, -170)])).toBe(0));
    it('negative duration → guarded to 0', () => expect(getExpiringDays(D(0), -5, [trip(-179, -170)])).toBe(0));
    it('multiple past trips, only the oldest expires', () =>
        expect(getExpiringDays(D(0), 10, [trip(-179, -170), trip(-50, -45)])).toBe(9));
});

describe('getCalendarDays — month grid with Monday-start padding', () => {
    const split = (arr) => ({
        nulls: arr.filter((x) => x === null).length,
        dayCount: arr.filter((x) => x !== null).length,
        firstDay: arr.find((x) => x !== null),
        lastDay: [...arr].reverse().find((x) => x !== null),
    });
    it('February 2024 (leap): 29 days, 3 leading nulls (Feb 1 is Thursday)', () => {
        const s = split(getCalendarDays(Date.UTC(2024, 1, 15)));
        expect(s.dayCount).toBe(29);
        expect(s.nulls).toBe(3);
        expect(s.firstDay).toBe(Date.UTC(2024, 1, 1));
        expect(s.lastDay).toBe(Date.UTC(2024, 1, 29));
    });
    it('February 2023 (non-leap): 28 days, 2 leading nulls (Feb 1 is Wednesday)', () => {
        const s = split(getCalendarDays(Date.UTC(2023, 1, 15)));
        expect(s.dayCount).toBe(28);
        expect(s.nulls).toBe(2);
    });
    it('January 2024: 31 days, 0 padding (Jan 1 is Monday)', () => {
        const s = split(getCalendarDays(Date.UTC(2024, 0, 15)));
        expect(s.dayCount).toBe(31);
        expect(s.nulls).toBe(0);
    });
    it('April 2024: 30 days', () => {
        expect(split(getCalendarDays(Date.UTC(2024, 3, 15))).dayCount).toBe(30);
    });
    it('month starting on Sunday → 6 leading nulls (Sep 2024)', () => {
        expect(split(getCalendarDays(Date.UTC(2024, 8, 15))).nulls).toBe(6);
    });
});

describe('getWeekStarts — ISO Monday week starts', () => {
    it('every entry is a UTC Monday, 7 days apart, default count 100', () => {
        const weeks = getWeekStarts(A);
        expect(weeks).toHaveLength(100);
        for (const w of weeks) expect(new Date(w).getUTCDay()).toBe(1);
        for (let i = 1; i < weeks.length; i++) expect(diffDays(weeks[i], weeks[i - 1])).toBe(7);
    });
    it('first week start is the Monday on/before (viewStart - 20 days)', () => {
        const weeks = getWeekStarts(A, 10);
        expect(weeks).toHaveLength(10);
        expect(weeks[0]).toBeLessThanOrEqual(A - 20 * MS_PER_DAY);
        expect(weeks[0]).toBeGreaterThan(A - 27 * MS_PER_DAY);
    });
});

describe('getMonths — timeline month bands', () => {
    const PX = 10;
    it('starts two months before viewStart and has `count` bands', () => {
        const months = getMonths(A, 'en-US', PX, 6);
        expect(months).toHaveLength(6);
        expect(months[0].d).toBe(Date.UTC(2023, 10, 1)); // Nov 2023 (Jan 2024 minus 2)
    });
    it('width = days-in-month × pxPerDay (leap Feb = 29×px)', () => {
        const months = getMonths(A, 'en-US', PX, 6);
        // index 0 Nov23(30) 1 Dec23(31) 2 Jan24(31) 3 Feb24(29 leap)
        expect(months[0].w).toBe(30 * PX);
        expect(months[2].w).toBe(31 * PX);
        expect(months[3].w).toBe(29 * PX);
    });
    it('isEven alternates and labels carry the right month', () => {
        const months = getMonths(A, 'en-US', PX, 6);
        expect(months[0].isEven).toBe(true);
        expect(months[1].isEven).toBe(false);
        expect(months[2].label).toContain('Jan');
        expect(months[3].label).toContain('Feb');
    });
});

// ---------------------------------------------------------------------------
// Property / oracle suite — independent brute-force references fuzzed against
// the optimized implementations over thousands of random DISJOINT trip sets.
// Passing proves calcUsage/calcSafe are sound for the app's (non-overlapping)
// invariant. (The calendar's isOverlap guard and drag collision check forbid
// overlapping trips.)
// ---------------------------------------------------------------------------
function calcUsageOracle(target, trips) {
    let used = 0;
    for (let d = target - 179 * MS_PER_DAY; d <= target; d += MS_PER_DAY) {
        if (trips.some((t) => d >= t.start && d <= t.end)) used++; // union membership
    }
    return used;
}

// Stay-validity is prefix-monotonic (extending a stay only adds presence), so a
// single forward scan suffices: the max safe length is the count of leading days
// that neither collide with a trip nor push the rolling window over 90.
function calcSafeOracle(arrDate, trips) {
    for (let j = 0; j < 90; j++) {
        const day = arrDate + j * MS_PER_DAY;
        if (trips.some((t) => day >= t.start && day <= t.end)) return j; // collision → can't occupy this day
        let cnt = 0;
        for (let w = day - 179 * MS_PER_DAY; w <= day; w += MS_PER_DAY) {
            const inTrip = trips.some((t) => w >= t.start && w <= t.end);
            const inStay = w >= arrDate && w <= day;
            if (inTrip || inStay) cnt++; // union, no double count
        }
        if (cnt > 90) return j; // staying through day j (j+1 days) busts → max is j
    }
    return 90;
}

// Deterministic PRNG (LCG) so any failure is reproducible.
function makeRng(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
function makeDisjoint(trips) {
    const sorted = [...trips].sort((a, b) => a.start - b.start);
    const out = [];
    let last = -Infinity;
    for (const t of sorted) { if (t.start > last) { out.push(t); last = t.end; } }
    return out;
}
function randDisjointTrips(rng) {
    const n = randInt(rng, 0, 6);
    const raw = [];
    for (let i = 0; i < n; i++) {
        const a = randInt(rng, -400, 400);
        const len = randInt(rng, 0, 120);
        raw.push({ id: `r${i}`, start: D(a), end: D(a + len) });
    }
    return makeDisjoint(raw);
}

describe('property: calcUsage matches the brute-force union oracle (disjoint trips)', () => {
    it('agrees over 3000 random cases', () => {
        const rng = makeRng(0xC0FFEE);
        for (let iter = 0; iter < 3000; iter++) {
            const trips = randDisjointTrips(rng);
            const target = D(randInt(rng, -500, 500));
            expect(calcUsage(target, trips)).toBe(calcUsageOracle(target, trips));
        }
    });
});

describe('property: calcSafe matches the brute-force max-stay oracle (disjoint trips)', () => {
    it('agrees over 3000 random cases', () => {
        const rng = makeRng(0xBADF00D);
        for (let iter = 0; iter < 3000; iter++) {
            const trips = randDisjointTrips(rng);
            const arr = D(randInt(rng, -300, 300));
            expect(calcSafe(arr, trips)).toBe(calcSafeOracle(arr, trips));
        }
    });
});

describe('documented invariant: calcUsage sums per-trip lengths (overlap double-count)', () => {
    // Unreachable in the app (overlaps are blocked), but pinned so it can never
    // regress silently. Overlapping trips are SUMMED, not unioned.
    it('overlapping trips are double-counted vs the union oracle', () => {
        const overlapping = [trip(-10, -1), trip(-5, -1)]; // share days -5..-1
        expect(calcUsage(D(0), overlapping)).toBe(15); // 10 + 5, summed
        expect(calcUsageOracle(D(0), overlapping)).toBe(10); // true union
    });
});
