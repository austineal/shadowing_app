import { useEffect, useState } from "react";
import { subscribeEpisode, subscribeEpisodes, subscribeSegments } from "../lib/episodes";
import type { Episode, SegmentsDoc } from "../types";

export function useEpisodes(uid: string) {
  const [episodes, setEpisodes] = useState<Episode[] | undefined>();
  const [error, setError] = useState<string>();
  useEffect(() => subscribeEpisodes(uid, setEpisodes, (e) => setError(e.message)), [uid]);
  return { episodes, error };
}

/** undefined while loading, null if the episode does not exist. */
export function useEpisode(uid: string, episodeId: string) {
  const [episode, setEpisode] = useState<Episode | null | undefined>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setEpisode(undefined);
    return subscribeEpisode(uid, episodeId, setEpisode, (e) => setError(e.message));
  }, [uid, episodeId]);
  return { episode, error };
}

/** undefined while loading, null if no segments have been generated yet. */
export function useSegmentsDoc(uid: string, episodeId: string) {
  const [segDoc, setSegDoc] = useState<SegmentsDoc | null | undefined>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setSegDoc(undefined);
    return subscribeSegments(uid, episodeId, setSegDoc, (e) => setError(e.message));
  }, [uid, episodeId]);
  return { segDoc, error };
}
