// Pure date / Schengen 90-180 calculation logic, extracted from main.jsx so it
// can be unit-tested without a DOM. All timestamps are UTC-midnight (ms).
// A trip is { id, start, end } with start/end inclusive UTC-midnight timestamps.

// --- DATE PRIMITIVES ---
export const MS_PER_DAY = 86400000;

// NOTE: toUTC intentionally reads LOCAL calendar fields and stamps them as a UTC
// midnight. This captures "the user's local today" (e.g. someone in Los Angeles at
// 20:00 on the 21st gets the 21st, not UTC's 22nd). Switching to getUTC* would be
// wrong for users west of UTC. See schengen.test.js for the TZ-pinned proof.
export const toUTC = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());

export const addDays = (ts, d) => ts + d * MS_PER_DAY;

export const diffDays = (t1, t2) => Math.round((t1 - t2) / MS_PER_DAY);

export const formatShortDate = (ts, locale = 'en-GB') =>
    new Date(ts).toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });

// --- CORE 90/180 MATH ---

// Days of presence inside the rolling 180-day window [target-179, target] (inclusive).
// Sums each trip clipped to the window. Trips are non-overlapping by app invariant
// (the calendar's isOverlap guard + drag collision check), so the per-trip sum equals
// the true union count; see the overlap regression test in schengen.test.js.
export function calcUsage(target, trips) {
    const winStart = target - (179 * MS_PER_DAY);
    let used = 0;
    trips.forEach(t => {
        const s = Math.max(t.start, winStart), e = Math.min(t.end, target);
        if (s <= e) used += diffDays(e, s) + 1;
    });
    return used;
}

// Max consecutive days (0..90) a single forward stay starting at arrDate may last
// without breaching the 90/180 rule, and without landing on a day already inside a
// trip. Only past trips (t.end < arrDate) can contribute to the window of any stay-day
// because a forward stay's future trips lie strictly after the stay.
export function calcSafe(arrDate, trips) {
    const tList = trips;
    for (let k = 1; k <= 90; k++) {
        const testDate = arrDate + ((k - 1) * MS_PER_DAY);
        if (tList.some(t => testDate >= t.start && testDate <= t.end)) return k - 1;

        const winStart = testDate - (179 * MS_PER_DAY);
        let daysInWindow = 0;
        tList.forEach(t => {
            const s = Math.max(t.start, winStart);
            const e = Math.min(t.end, testDate);
            if (s <= e && t.end < arrDate) daysInWindow += diffDays(e, s) + 1;
        });
        daysInWindow += k;

        if (daysInWindow > 90) return k - 1;
    }
    return 90;
}

// Clear days since the previous trip / until the next trip, relative to `date`.
// If `date` is on or inside a trip, the traveller is currently on a trip, so there is
// no gap (since/until = 0) and inTrip is flagged. The -1 encodes the convention that a
// trip ending the day before `date` (adjacent) counts as 0 clear days.
export function getGapStats(date, trips) {
    const inTrip = trips.find(t => date >= t.start && date <= t.end);
    if (inTrip) return { since: 0, until: 0, inTrip: true };
    const past = trips.filter(t => t.end < date).sort((a, b) => b.end - a.end)[0];
    const future = trips.filter(t => t.start > date).sort((a, b) => a.start - b.start)[0];
    return {
        since: past ? diffDays(date, past.end) - 1 : null,
        until: future ? diffDays(future.start, date) - 1 : null,
    };
}

// How many already-used (past) days will drop out of the rolling window during a stay
// of `duration` days starting at `date` (window slides forward by duration-1 days).
export function getExpiringDays(date, duration, trips) {
    if (duration <= 0) return 0;
    const tList = trips;
    const stayEnd = date + ((duration - 1) * MS_PER_DAY);
    const startWindowStart = date - (179 * MS_PER_DAY);
    const endWindowStart = stayEnd - (179 * MS_PER_DAY);
    let expiring = 0;
    tList.forEach(t => {
        if (t.end < date) {
            const s1 = Math.max(t.start, startWindowStart);
            const e1 = Math.min(t.end, date);
            const usedAtStart = (s1 <= e1) ? diffDays(e1, s1) + 1 : 0;
            const s2 = Math.max(t.start, endWindowStart);
            const e2 = Math.min(t.end, stayEnd);
            const usedAtEnd = (s2 <= e2) ? diffDays(e2, s2) + 1 : 0;
            if (usedAtStart > usedAtEnd) expiring += (usedAtStart - usedAtEnd);
        }
    });
    return expiring;
}

// --- GRID GENERATION ---

// Calendar-month grid for `curr` (any timestamp in the month): leading nulls pad to a
// Monday-start week, followed by each day's UTC-midnight timestamp.
export function getCalendarDays(curr) {
    const d = new Date(curr);
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    const total = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const arr = Array((first === 0 ? 6 : first - 1)).fill(null);
    for (let i = 1; i <= total; i++) arr.push(Date.UTC(y, m, i));
    return arr;
}

// `count` consecutive Monday (ISO week-start) UTC-midnight timestamps, beginning from
// the Monday of the week containing (viewStart - 20 days).
export function getWeekStarts(viewStart, count = 100) {
    const arr = [];
    const d = new Date(viewStart - (20 * MS_PER_DAY));
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    d.setUTCDate(diff);
    for (let i = 0; i < count; i++) {
        const wDate = new Date(d);
        wDate.setUTCDate(wDate.getUTCDate() + (i * 7));
        arr.push(toUTC(wDate));
    }
    return arr;
}

// `count` month bands starting 2 months before viewStart's month. Each band: month
// start ts, pixel width (days-in-month * pxPerDay), localized label, even/odd flag.
export function getMonths(viewStart, locale, pxPerDay, count = 36) {
    const arr = [];
    const startM = new Date(viewStart);
    startM.setUTCDate(1);
    startM.setUTCHours(0, 0, 0, 0);
    startM.setUTCMonth(startM.getUTCMonth() - 2);

    for (let i = 0; i < count; i++) {
        const d = new Date(startM);
        d.setUTCMonth(d.getUTCMonth() + i);
        const next = new Date(d);
        next.setUTCMonth(next.getUTCMonth() + 1);
        const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
        const nextMonthStart = Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), 1);
        const w = diffDays(nextMonthStart, monthStart) * pxPerDay;
        arr.push({ d: monthStart, w, label: d.toLocaleDateString(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' }), isEven: i % 2 === 0 });
    }
    return arr;
}
