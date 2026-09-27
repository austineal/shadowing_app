import { useEffect, useState } from "react";
import { subscribeFolders, subscribeSubscriptions } from "../lib/library";
import type { Folder, Subscription } from "../types";

export function useFolders(uid: string) {
  const [folders, setFolders] = useState<Folder[] | undefined>();
  const [error, setError] = useState<string>();
  useEffect(() => subscribeFolders(uid, setFolders, (e) => setError(e.message)), [uid]);
  return { folders, error };
}

export function useSubscriptions(uid: string) {
  const [subscriptions, setSubscriptions] = useState<Subscription[] | undefined>();
  const [error, setError] = useState<string>();
  useEffect(() => subscribeSubscriptions(uid, setSubscriptions, (e) => setError(e.message)), [uid]);
  return { subscriptions, error };
}
