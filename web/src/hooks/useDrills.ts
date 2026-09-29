import { useEffect, useState } from "react";
import { subscribeDrillPrefs, subscribeDrills, subscribeRecentSessions } from "../lib/drill/store";
import { DAY_MS } from "../lib/drill/srs";
import type { Drill, DrillPrefs, DrillSessionLog } from "../types";

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

/** Drill sessions from the last eight days (enough to place every schedule), live. */
export function useRecentSessions(uid: string) {
  const [since] = useState(() => Date.now() - 8 * DAY_MS);
  const [sessions, setSessions] = useState<DrillSessionLog[] | undefined>();
  useEffect(() => subscribeRecentSessions(uid, since, setSessions), [uid, since]);
  return sessions;
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
