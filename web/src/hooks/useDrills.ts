import { useEffect, useState } from "react";
import { subscribeDrillPrefs, subscribeDrills, subscribeExcerptSuggestions, subscribeRecentSessions } from "../lib/drill/store";
import { DAY_MS } from "../lib/drill/srs";
import { useLive } from "./useLive";
import type { Drill, DrillPrefs, DrillSessionLog, ExcerptSuggestions } from "../types";

/** All drill excerpts, live. undefined while loading. */
export function useDrills(uid: string) {
  return useLive<Drill[] | undefined>((set) => subscribeDrills(uid, set), [uid], undefined)[0];
}

/** Per-language drill schedules, live. undefined while loading. */
export function useDrillPrefs(uid: string) {
  return useLive<DrillPrefs | undefined>((set) => subscribeDrillPrefs(uid, set), [uid], undefined)[0];
}

/** Drill sessions from the last four weeks (enough to place every schedule and measure pace), live. */
export function useRecentSessions(uid: string) {
  const [since] = useState(() => Date.now() - 29 * DAY_MS);
  return useLive<DrillSessionLog[] | undefined>((set) => subscribeRecentSessions(uid, since, set), [uid, since], undefined)[0];
}

/** Claude's excerpt suggestions for an episode, live: undefined while loading, null if there are none. */
export function useExcerptSuggestions(uid: string, episodeId: string) {
  return useLive<ExcerptSuggestions | null | undefined>((set) => subscribeExcerptSuggestions(uid, episodeId, set), [uid, episodeId], undefined)[0];
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
