/**
 * Spaced-repetition schedule for drill passages. A passage climbs one level each time it passes a
 * review and drops one when it fails; each level waits roughly twice as long as the one before.
 */
import type { DrillPassage } from "../../types";

/** Days until the next review, by level. Level 0 (just learned, or failed from level 1) means the next session. */
const INTERVAL_DAYS = [0, 1, 3, 7, 15, 30, 60, 120, 240];
export const MAX_LEVEL = INTERVAL_DAYS.length - 1;

const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** Review days start at 4am, so a late-night session still counts for that day. */
const DAY_START_HOUR = 4;
/** "The next session": any session starting at least this long after the passage was learned or failed. */
export const NEXT_SESSION_MS = HOUR_MS;

/** Local review day of a time, as a day count (days since 1970-01-01 of the local date). */
export function dayNumber(ms: number): number {
  // Local calendar date and hour rather than `ms - 4h`, which lands on the wrong date on the
  // morning the clocks go forward.
  const d = new Date(ms);
  const date = Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
  return d.getHours() < DAY_START_HOUR ? date - 1 : date;
}

/** When a review day starts (local time). */
export function dayStart(day: number): number {
  const d = new Date(day * DAY_MS);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DAY_START_HOUR).getTime();
}

/**
 * Picks the day a review lands on, from `days` (consecutive day numbers around `base`, the day
 * its interval gives), for a passage that has just reached `level`.
 */
export type DayChooser = (days: number[], base: number, level: number) => number;

/** How far a review may move from its planned day onto a lighter one: not at all for gaps under a week, then about a tenth of the gap. */
export function spreadDays(intervalDays: number): number {
  return intervalDays < 7 ? 0 : Math.max(1, Math.round(intervalDays / 10));
}

/**
 * When a passage that reached `level` at time `at` is next due. With `choose`, a long gap may
 * stretch or shrink a little (see spreadDays) to land on the day it picks.
 */
export function dueAfter(level: number, at: number, choose?: DayChooser): number {
  if (level <= 0) return at + NEXT_SESSION_MS;
  const interval = INTERVAL_DAYS[Math.min(level, MAX_LEVEL)];
  const base = dayNumber(at) + interval;
  const spread = choose ? spreadDays(interval) : 0;
  if (!choose || spread === 0) return dayStart(base);
  const days = Array.from({ length: 2 * spread + 1 }, (_, k) => base - spread + k);
  const day = choose(days, base, level);
  return dayStart(days.includes(day) ? day : base);
}

export function isLearned(p: DrillPassage): boolean {
  return p.level !== undefined;
}

export function isDue(p: DrillPassage, now: number): boolean {
  return p.level !== undefined && (p.due ?? 0) <= now;
}

/** How badly a due passage needs its review: time past due, relative to its interval. */
export function overdueRatio(p: DrillPassage, now: number): number {
  const interval = Math.max(0.5, INTERVAL_DAYS[Math.min(p.level ?? 0, MAX_LEVEL)]) * DAY_MS;
  return (now - (p.due ?? now)) / interval;
}

/** A passage whose learning drill has just finished. */
export function learnedPassage(p: DrillPassage, now: number): DrillPassage {
  return { ...p, level: 0, due: dueAfter(0, now), last: now, reviews: 0, lapses: 0 };
}

/**
 * Whether a review passes: at most one missed cue, or none in a passage of three cues or fewer,
 * where one miss is a large share. (A cue covers a phrase at first, more as the passage matures.)
 */
export function reviewPasses(misses: number, cues: number): boolean {
  return misses === 0 || (misses === 1 && cues >= 4);
}

/**
 * A passage after a review. Passing moves it up a level; if it passed after a longer gap than
 * planned (a missed day, say), it moves up to the level matching the gap it survived, so time off
 * doesn't cost extra reviews of what's still remembered. Failing moves it down one level.
 * `choose` can move a long gap's next review onto a lighter day (see dueAfter).
 */
export function reviewedPassage(p: DrillPassage, passed: boolean, now: number, choose?: DayChooser): DrillPassage {
  const level = p.level ?? 0;
  const reviews = (p.reviews ?? 0) + 1;
  if (!passed) {
    const down = Math.max(0, level - 1);
    return { ...p, level: down, due: dueAfter(down, now, choose), last: now, reviews, lapses: (p.lapses ?? 0) + 1 };
  }
  const gapDays = p.last === undefined ? 0 : dayNumber(now) - dayNumber(p.last);
  let next = Math.min(MAX_LEVEL, level + 1);
  while (next < MAX_LEVEL && INTERVAL_DAYS[next] <= gapDays) next++;
  return { ...p, level: next, due: dueAfter(next, now, choose), last: now, reviews };
}
