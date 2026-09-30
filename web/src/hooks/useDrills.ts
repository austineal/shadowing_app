import { useEffect, useState } from "react";
import { subscribeDrillPrefs, subscribeDrills, subscribeExcerptSuggestions, subscribeRecentSessions } from "../lib/drill/store";
import { DAY_MS } from "../lib/drill/srs";
import type { Drill, DrillPrefs, DrillSessionLog, ExcerptSuggestions } from "../types";

/** All drill excerpts, live. undefined while loading. */
export function useDrills(uid: string) {
  const [drills, setDrills] = useState<Drill[] | undefined>();
  useEffect(() => subscribeDrills(uid, setDrills), [uid]);
  return drills;
}

/** Per-language drill schedules, live. undefined while loading. */
export function useDrillPrefs(uid: string) {
  const [prefs, setPrefs] = useState<DrillPrefs | undefined>();
  useEffect(() => subscribeDrillPrefs(uid, setPrefs), [uid]);
  return prefs;
}

/** Drill sessions from the last four weeks (enough to place every schedule and measure pace), live. */
export function useRecentSessions(uid: string) {
  const [since] = useState(() => Date.now() - 29 * DAY_MS);
  const [sessions, setSessions] = useState<DrillSessionLog[] | undefined>();
  useEffect(() => subscribeRecentSessions(uid, since, setSessions), [uid, since]);
  return sessions;
}

/** Claude's excerpt suggestions for an episode, live: undefined while loading, null if there are none. */
export function useExcerptSuggestions(uid: string, episodeId: string) {
  const [suggestions, setSuggestions] = useState<ExcerptSuggestions | null | undefined>();
  useEffect(() => subscribeExcerptSuggestions(uid, episodeId, setSuggestions), [uid, episodeId]);
  return suggestions;
}

/** The current time, updated every `ms`, for displays that depend on it. */
export function useNow(ms = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
