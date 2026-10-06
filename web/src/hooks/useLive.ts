import { useEffect, useState, type DependencyList } from "react";
import { subscribeStudyLevels } from "../lib/study";
import type { CefrLevel } from "../types";

/** A live subscription's latest value (`initial` until it arrives, and again when `deps` change) and its last error. */
export function useLive<T>(
  subscribe: (set: (v: T) => void, onError: (e: Error) => void) => () => void,
  deps: DependencyList,
  initial: T,
): [T, string | undefined] {
  const [value, setValue] = useState<T>(initial);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setValue(initial);
    return subscribe(setValue, (e) => setError(e.message));
  }, deps);
  return [value, error];
}

/** The learner's CEFR level per language, live. */
export function useStudyLevels(uid: string): Record<string, CefrLevel> {
  return useLive<Record<string, CefrLevel>>((set) => subscribeStudyLevels(uid, set), [uid], {})[0];
}
