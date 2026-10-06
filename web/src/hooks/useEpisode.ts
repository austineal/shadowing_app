import { subscribeEpisode, subscribeEpisodes, subscribeSegments } from "../lib/episodes";
import type { Episode, SegmentsDoc } from "../types";
import { useLive } from "./useLive";

export function useEpisodes(uid: string) {
  const [episodes, error] = useLive<Episode[] | undefined>((set, err) => subscribeEpisodes(uid, set, err), [uid], undefined);
  return { episodes, error };
}

/** undefined while loading, null if the episode does not exist. */
export function useEpisode(uid: string, episodeId: string) {
  const [episode, error] = useLive<Episode | null | undefined>((set, err) => subscribeEpisode(uid, episodeId, set, err), [uid, episodeId], undefined);
  return { episode, error };
}

/** undefined while loading, null if no segments have been generated yet. */
export function useSegmentsDoc(uid: string, episodeId: string) {
  const [segDoc, error] = useLive<SegmentsDoc | null | undefined>((set, err) => subscribeSegments(uid, episodeId, set, err), [uid, episodeId], undefined);
  return { segDoc, error };
}
