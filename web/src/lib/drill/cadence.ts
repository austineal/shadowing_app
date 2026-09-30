/**
 * When each language's drill sessions come up. Languages drilled every day can have several
 * sessions a day, a few hours apart; others come up every few days, counted from an anchor day so
 * that languages on the same rhythm can take turns.
 */
import type { DrillSchedule } from "../../types";
import { dayNumber, dayStart } from "./srs";

const HOUR_MS = 3_600_000;

export interface SessionTimes {
  startedAt: number;
  endedAt: number;
}

export interface Availability {
  /** A session is due now (possibly overdue). */
  due: boolean;
  /** When the next session becomes due, if one isn't due now. */
  next?: number;
  /** Sessions already done today. */
  doneToday: number;
}

/** Minimum time between sessions of a language drilled several times a day. */
export function hoursBetweenSessions(perDay: number): number {
  return perDay >= 3 ? 3 : 5;
}

/** Whether a language's session is due, given its schedule and its recent sessions (any order). */
export function availability(schedule: DrillSchedule, sessions: SessionTimes[], now: number): Availability {
  const today = dayNumber(now);
  const last = sessions.reduce<SessionTimes | undefined>((a, s) => (!a || s.startedAt > a.startedAt ? s : a), undefined);
  const doneToday = sessions.filter((s) => dayNumber(s.startedAt) === today).length;

  if (schedule.everyDays <= 1) {
    const perDay = Math.min(3, Math.max(1, Math.round(schedule.perDay)));
    if (doneToday >= perDay) return { due: false, next: dayStart(today + 1), doneToday };
    if (doneToday === 0 || !last) return { due: true, doneToday };
    const earliest = last.endedAt + hoursBetweenSessions(perDay) * HOUR_MS;
    return now >= earliest ? { due: true, doneToday } : { due: false, next: earliest, doneToday };
  }

  const every = Math.round(schedule.everyDays);
  const anchor = schedule.anchorDay ?? (last ? dayNumber(last.startedAt) : today);
  // A language set up to take the day after another's turn doesn't start before it.
  if (today < anchor) return { due: false, next: dayStart(anchor), doneToday };
  // The latest scheduled day on or before today; due until a session has happened since then.
  const slot = today - (((today - anchor) % every) + every) % every;
  if (!last || dayNumber(last.startedAt) < slot) return { due: true, doneToday };
  return { due: false, next: dayStart(slot + every), doneToday };
}

/**
 * The anchor day for a language that is to come up every `every` days: the first day from today
 * whose turn is shared by the fewest other languages on the same rhythm, so that, for example,
 * two languages drilled every other day alternate.
 */
export function pickAnchorDay(others: DrillSchedule[], every: number, today: number): number {
  let best = today;
  let bestLoad = Infinity;
  for (let o = 0; o < every; o++) {
    const day = today + o;
    const load = others.filter(
      (s) => Math.round(s.everyDays) === every && s.anchorDay !== undefined && (((day - s.anchorDay) % every) + every) % every === 0,
    ).length;
    if (load < bestLoad) {
      best = day;
      bestLoad = load;
    }
  }
  return best;
}
