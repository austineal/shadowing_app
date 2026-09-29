import type { DrillSchedule } from "../../types";
import type { Cue } from "./steps";
import { dayNumber } from "./srs";

/** The rhythms offered for a language. */
export const FREQUENCIES = [
  { id: "3/day", label: "Three times a day", perDay: 3, everyDays: 1 },
  { id: "2/day", label: "Twice a day", perDay: 2, everyDays: 1 },
  { id: "daily", label: "Every day", perDay: 1, everyDays: 1 },
  { id: "2days", label: "Every other day", perDay: 1, everyDays: 2 },
  { id: "3days", label: "Every three days", perDay: 1, everyDays: 3 },
  { id: "weekly", label: "Once a week", perDay: 1, everyDays: 7 },
] as const;

export function frequencyOf(s: DrillSchedule): (typeof FREQUENCIES)[number] {
  return (
    FREQUENCIES.find((f) => f.everyDays === Math.round(s.everyDays) && (f.everyDays > 1 || f.perDay === Math.round(s.perDay))) ??
    FREQUENCIES[2]
  );
}

export const SESSION_MINUTES = [10, 15, 20, 25, 30, 40, 45, 60];

/** A new language's schedule until the learner changes it. */
export const DEFAULT_SCHEDULE: DrillSchedule = { perDay: 1, everyDays: 1, minutes: 20, newMaterial: true, learning: "full" };

export const CUE_LABEL: Record<Cue, string> = {
  "lead-in": "Lead-in",
  english: "English",
  speak: "Your turn: say it",
  answer: "Answer",
  listen: "Listen",
  repeat: "Repeat",
  shadow: "Shadow along",
};

/** When the next session is: "after 17:20" (later today), "tomorrow", "on Thursday" or a date. */
export function formatNext(next: number, now: number): string {
  const days = dayNumber(next) - dayNumber(now);
  const d = new Date(next);
  if (days <= 0) return `after ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  if (days === 1) return "tomorrow";
  if (days < 7) return `on ${d.toLocaleDateString(undefined, { weekday: "long" })}`;
  return `on ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/** "2 h 30 min", "45 min" */
export function formatMinutes(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `${m} min`;
  const rounded = Math.round(m / 15) * 15;
  const h = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}
