import { subscribeFolders, subscribeSubscriptions } from "../lib/library";
import type { Folder, Subscription } from "../types";
import { useLive } from "./useLive";

export function useFolders(uid: string) {
  const [folders, error] = useLive<Folder[] | undefined>((set, err) => subscribeFolders(uid, set, err), [uid], undefined);
  return { folders, error };
}

export function useSubscriptions(uid: string) {
  const [subscriptions, error] = useLive<Subscription[] | undefined>((set, err) => subscribeSubscriptions(uid, set, err), [uid], undefined);
  return { subscriptions, error };
}
