/**
 * How much new audio a language's drills get through in a week, which sizes suggested excerpts.
 * Measured from the session logs once they go back two weeks; until then estimated from the
 * schedule, assuming reviews settle at a little over half of each session (as the load model
 * behind the drill design found).
 */
import type { DrillSchedule, DrillSessionLog } from "../../types";
import { learningSeconds } from "./plan";
import { DAY_MS } from "./srs";
import type { DrillOptions, SessionPhrase } from "./steps";

/** Share of session time that goes to new material once reviews have built up. */
const NEW_SHARE = 0.45;
/** How far back a measured pace looks. */
const WINDOW_DAYS = 28;
/** A measured pace is used once the logs go back this far. */
const MIN_HISTORY_DAYS = 14;

export interface Pace {
  /** Seconds of new audio learned per week. */
  perWeek: number;
  /** Measured from sessions, rather than estimated from the schedule. */
  measured: boolean;
}

export function sessionsPerWeek(s: DrillSchedule): number {
  return s.everyDays <= 1 ? 7 * Math.max(1, Math.round(s.perDay)) : 7 / Math.round(s.everyDays);
}

/** Minutes of drilling it takes to learn a minute of audio, by the session planner's own estimate. */
export function drillMinutesPerAudioMinute(opts: DrillOptions): number {
  // A typical passage: six 7-second phrases with short pauses between them.
  const phrases: SessionPhrase[] = Array.from({ length: 6 }, (_, i) => ({ start: i * 7.5, end: i * 7.5 + 7, text: "" }));
  return learningSeconds([phrases], opts) / (phrases[5].end - phrases[0].start);
}

/** The pace for a language, from its schedule and its session logs (any age; older ones are ignored). */
export function weeklyPace(schedule: DrillSchedule, logs: DrillSessionLog[], opts: DrillOptions, now: number): Pace {
  const estimate = (sessionsPerWeek(schedule) * schedule.minutes * 60 * NEW_SHARE) / drillMinutesPerAudioMinute(opts);
  const recorded = logs.filter((l) => typeof l.learnedSeconds === "number" && l.startedAt <= now);
  const history = recorded.length ? (now - Math.min(...recorded.map((l) => l.startedAt))) / DAY_MS : 0;
  if (history < MIN_HISTORY_DAYS) return { perWeek: estimate, measured: false };
  const days = Math.min(history, WINDOW_DAYS);
  const learned = recorded.filter((l) => l.startedAt >= now - days * DAY_MS).reduce((sum, l) => sum + (l.learnedSeconds ?? 0), 0);
  // A lull (time off, new material switched off) shouldn't shrink suggestions to nothing.
  return { perWeek: Math.max(learned / (days / 7), estimate / 4), measured: true };
}

/** Length to suggest for an excerpt: about two weeks of new material, from 2 to 20 minutes. */
export function excerptMinutes(p: Pace): number {
  return Math.min(20, Math.max(2, Math.round((p.perWeek * 2) / 60)));
}

/** How long learning `sec` of audio takes at a pace: "about 4 days", "about a week", "about 3 weeks". */
export function formatLearningTime(sec: number, p: Pace): string {
  const days = (sec / p.perWeek) * 7;
  if (days < 5.5) {
    const d = Math.max(1, Math.round(days));
    return `about ${d} ${d === 1 ? "day" : "days"}`;
  }
  const weeks = Math.round(days / 7);
  return weeks <= 1 ? "about a week" : `about ${weeks} weeks`;
}
