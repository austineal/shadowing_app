/**
 * The review load ahead for one language: roughly how long the reviews on each upcoming session
 * day will take if they all go well. It shows the coming fortnight with the schedules, holds back
 * a new passage whose reviews would overfill a session in the coming week, and spreads long-gap
 * reviews onto lighter days.
 *
 * Review times are estimated from each passage's audio length, so the forecast works without
 * loading any phrases.
 */
import type { DrillPassage, DrillSchedule } from "../../types";
import { availability, type SessionTimes } from "./cadence";
import { blockSeconds, type ReviewBlock } from "./session";
import { MAX_LEVEL, dayNumber, dayStart, learnedPassage, reviewedPassage, type DayChooser } from "./srs";
import type { DrillOptions, SessionPhrase } from "./steps";

/**
 * Share of session time that reviews settle at once a language is under way (the load model
 * behind the drill design); the rest goes to new material.
 */
export const REVIEW_SHARE = 0.55;

/** How far ahead a new passage's reviews must fit. */
const HOLD_BACK_DAYS = 7;
const HOUR_MS = 3_600_000;

export interface SessionDay {
  day: number;
  sessions: number;
  /** The time those sessions have, in seconds. */
  capacitySec: number;
}

export interface LoadDay extends SessionDay {
  /** Review time booked for the day, plus whatever didn't fit on earlier days. */
  reviewSec: number;
  reviews: number;
}

/** Sessions a day for a language drilled daily; 1 for one drilled every few days. */
export function sessionsPerDay(schedule: DrillSchedule): number {
  return schedule.everyDays <= 1 ? Math.min(3, Math.max(1, Math.round(schedule.perDay))) : 1;
}

/**
 * The language's session days over the next `days` days, today first if it still has a session
 * to come. `sessions` are its recent sessions that count (see availability).
 */
export function sessionDays(schedule: DrillSchedule, sessions: SessionTimes[], now: number, days: number): SessionDay[] {
  const today = dayNumber(now);
  const a = availability(schedule, sessions, now);
  const day = (d: number, n: number): SessionDay => ({ day: d, sessions: n, capacitySec: n * schedule.minutes * 60 });
  const out: SessionDay[] = [];
  if (schedule.everyDays <= 1) {
    const perDay = sessionsPerDay(schedule);
    if (perDay > a.doneToday) out.push(day(today, perDay - a.doneToday));
    for (let d = today + 1; d < today + days; d++) out.push(day(d, perDay));
    return out;
  }
  const every = Math.round(schedule.everyDays);
  const last = sessions.reduce((m, s) => Math.max(m, s.startedAt), -Infinity);
  const anchor = schedule.anchorDay ?? (sessions.length ? dayNumber(last) : today);
  if (a.due) out.push(day(today, 1));
  for (let d = today + 1; d < today + days; d++) if (d >= anchor && (d - anchor) % every === 0) out.push(day(d, 1));
  return out;
}

/** The first day from `day` on that the language has a session (by its rhythm, ignoring what's been done). */
export function sessionDayFrom(schedule: DrillSchedule, day: number): number {
  if (schedule.everyDays <= 1 || schedule.anchorDay === undefined) return day;
  const every = Math.round(schedule.everyDays);
  if (day < schedule.anchorDay) return schedule.anchorDay;
  const off = (day - schedule.anchorDay) % every;
  return off === 0 ? day : day + every - off;
}

const estimates = new WeakMap<DrillOptions, Map<string, number>>();

/**
 * Rough length of a passage's review at a level, from its audio length alone: as if it were
 * phrases of about six seconds, two to a sentence, with English about as long as the original.
 */
export function reviewSeconds(durationSec: number, level: number, opts: DrillOptions): number {
  let memo = estimates.get(opts);
  if (!memo) estimates.set(opts, (memo = new Map()));
  const sec = Math.max(2, Math.round(durationSec));
  const lvl = Math.max(0, Math.min(level, MAX_LEVEL));
  const key = `${sec}:${lvl}`;
  const known = memo.get(key);
  if (known !== undefined) return known;

  const n = Math.max(1, Math.round(sec / 6.5));
  const len = (sec - (n - 1) * 0.5) / n;
  const phrase = (i: number): SessionPhrase => ({
    start: i * (len + 0.5),
    end: i * (len + 0.5) + len,
    text: i % 2 ? "x." : "x,",
    english: "x".repeat(Math.round(len * 12)),
  });
  const block: ReviewBlock = {
    kind: "review",
    drillId: "",
    episodeId: "",
    title: "",
    passage: 0,
    passageCount: 1,
    level: lvl,
    phrases: Array.from({ length: n }, (_, i) => phrase(i)),
    leadIn: phrase(-1),
  };
  const est = blockSeconds(block, opts);
  memo.set(key, est);
  return est;
}

/**
 * Follows a passage through its reviews over the given days, assuming each one passes: it comes up
 * on the first session day on or after it's due (at most once a day), and its next interval runs
 * from there. `visit` gets the index of each day it comes up on and its level then.
 */
function followReviews(p: DrillPassage, days: SessionDay[], now: number, visit: (k: number, level: number) => void) {
  const today = dayNumber(now);
  let cur = p;
  let k = 0;
  while (cur.level !== undefined) {
    const due = Math.max(today, dayNumber(cur.due ?? now));
    while (k < days.length && days[k].day < due) k++;
    if (k >= days.length) return;
    visit(k, cur.level);
    // Reviewed during the day's sessions: now if that's today, else around midday.
    const at = days[k].day === today ? now : dayStart(days[k].day) + 8 * HOUR_MS;
    cur = reviewedPassage(cur, true, at);
    k++;
  }
}

/** Review time on each of the given session days, if every review passes. Whatever a day can't fit is carried to the next. */
export function forecastLoad(passages: DrillPassage[], days: SessionDay[], now: number, opts: DrillOptions): LoadDay[] {
  const load: LoadDay[] = days.map((d) => ({ ...d, reviewSec: 0, reviews: 0 }));
  for (const p of passages) {
    followReviews(p, days, now, (k, level) => {
      load[k].reviewSec += reviewSeconds(p.end - p.start, level, opts);
      load[k].reviews++;
    });
  }
  let carried = 0;
  for (const d of load) {
    d.reviewSec += carried;
    carried = Math.max(0, d.reviewSec - d.capacitySec);
  }
  return load;
}

/**
 * Whether learning a passage of `durationSec` now would overfill a session in the coming week: the
 * first day where its reviews (at the next session, a day later, then three days after that) would
 * take the booked reviews past the time the day's sessions have.
 */
export function overfilledBy(load: LoadDay[], durationSec: number, now: number, opts: DrillOptions): LoadDay | undefined {
  let full: LoadDay | undefined;
  const last = dayNumber(now) + HOLD_BACK_DAYS;
  followReviews(learnedPassage({ start: 0, end: durationSec }, now), load, now, (k, level) => {
    const d = load[k];
    if (!full && d.day <= last && d.reviewSec + reviewSeconds(durationSec, level, opts) > d.capacitySec) full = d;
  });
  return full;
}

/** Adds the reviews of a passage learned now to the load. */
export function bookNewPassage(load: LoadDay[], durationSec: number, now: number, opts: DrillOptions): void {
  followReviews(learnedPassage({ start: 0, end: durationSec }, now), load, now, (k, level) => {
    load[k].reviewSec += reviewSeconds(durationSec, level, opts);
    load[k].reviews++;
  });
}

/** Review time booked on each session day by the passages' next reviews (overdue ones count for today). */
export function bookedByDay(passages: DrillPassage[], schedule: DrillSchedule, now: number, opts: DrillOptions): Map<number, number> {
  const today = dayNumber(now);
  const booked = new Map<number, number>();
  for (const p of passages) {
    if (p.level === undefined || p.due === undefined) continue;
    const day = sessionDayFrom(schedule, Math.max(today, dayNumber(p.due)));
    booked.set(day, (booked.get(day) ?? 0) + reviewSeconds(p.end - p.start, p.level, opts));
  }
  return booked;
}

/**
 * Where to put a passage's next review when its gap allows some leeway (see dueAfter): on the
 * planned day while that day's reviews stay within their usual share of its sessions, otherwise on
 * the candidate day with the least booked (the nearest of equals). Keeping to the planned day when
 * there's room keeps neighbouring passages coming up together, in story order.
 */
export function spreadReviews(
  booked: Map<number, number>,
  schedule: DrillSchedule,
  durationSec: number,
  opts: DrillOptions,
): DayChooser {
  const comfortable = sessionsPerDay(schedule) * schedule.minutes * 60 * REVIEW_SHARE;
  const loadOn = (d: number) => booked.get(sessionDayFrom(schedule, d)) ?? 0;
  return (days, base, level) => {
    if (loadOn(base) + reviewSeconds(durationSec, level, opts) <= comfortable) return base;
    return [...days].sort((a, b) => loadOn(a) - loadOn(b) || Math.abs(a - base) - Math.abs(b - base) || a - b)[0];
  };
}
