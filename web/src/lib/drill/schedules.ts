/**
 * A language can have several drill schedules, each with its own drills (one per podcast or deck,
 * say). The main one is keyed by the language code, so drills, logs and schedules from before
 * there could be more than one belong to it unchanged.
 */
import { languageLabel } from "../languages";
import type { Drill, DrillPrefs, DrillSchedule, DrillSessionLog } from "../../types";

/** The language a schedule drills. */
export function scheduleLanguage(key: string, schedule: DrillSchedule | undefined): string {
  return schedule?.language ?? key;
}

/** "Japanese", or "Japanese · News podcast" for a named schedule. */
export function scheduleLabel(key: string, schedule: DrillSchedule | undefined): string {
  const language = languageLabel(scheduleLanguage(key, schedule));
  return schedule?.name ? `${language} · ${schedule.name}` : language;
}

/** The schedule a drill is on: its own if that still exists, else its language's main one. */
export function drillScheduleKey(drill: Pick<Drill, "language" | "schedule">, prefs: DrillPrefs | undefined): string {
  return drill.schedule && prefs?.schedules[drill.schedule] ? drill.schedule : drill.language;
}

/** The schedule a session was of (see drillScheduleKey). */
export function logScheduleKey(log: Pick<DrillSessionLog, "language" | "schedule">, prefs: DrillPrefs | undefined): string {
  return log.schedule && prefs?.schedules[log.schedule] ? log.schedule : log.language;
}

/** The keys of a language's schedules, the main one first and the others in the order they were added. */
export function schedulesOf(prefs: DrillPrefs | undefined, language: string): string[] {
  const keys = Object.keys(prefs?.schedules ?? {}).filter((k) => k !== language && prefs!.schedules[k].language === language);
  return [...(prefs?.schedules[language] ? [language] : []), ...keys.sort()];
}

/** A key for a new schedule of the language: sorts after the language's earlier ones. */
export function newScheduleKey(language: string, now = Date.now()): string {
  return `${language}_${now.toString(36)}`;
}

/** The schedule a new excerpt of an episode most likely belongs on: that of the episode's latest drill, else the main one. */
export function scheduleForEpisode(prefs: DrillPrefs | undefined, language: string, existing: Drill[]): string {
  const latest = existing.reduce<Drill | undefined>((a, d) => (!a || d.createdAt > a.createdAt ? d : a), undefined);
  return latest ? drillScheduleKey(latest, prefs) : language;
}
