import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "../firebase";
import { episodesCollection, fetchFeed, type FeedResult } from "./episodes";
import { feedStats } from "./organise";
import type { Folder, Subscription } from "../types";

// ---- Folders ----

function foldersCollection(uid: string) {
  return collection(db, "users", uid, "folders");
}

export function subscribeFolders(uid: string, cb: (folders: Folder[]) => void, onError?: (e: Error) => void): Unsubscribe {
  const q = query(foldersCollection(uid), orderBy("name"));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Folder, "id">) }))), onError);
}

export async function createFolder(uid: string, name: string, language: string): Promise<string> {
  const ref = await addDoc(foldersCollection(uid), { name: name.trim(), language, createdAt: serverTimestamp() });
  return ref.id;
}

export async function renameFolder(uid: string, folderId: string, name: string): Promise<void> {
  await updateDoc(doc(foldersCollection(uid), folderId), { name: name.trim() });
}

/** Deletes the folder and moves its episodes back to unfiled. Episodes themselves are kept. */
export async function deleteFolder(uid: string, folderId: string): Promise<void> {
  const inFolder = await getDocs(query(episodesCollection(uid), where("folderId", "==", folderId)));
  const batch = writeBatch(db);
  for (const d of inFolder.docs) batch.update(d.ref, { folderId: null, updatedAt: serverTimestamp() });
  batch.delete(doc(foldersCollection(uid), folderId));
  await batch.commit();
}

// ---- Subscriptions ----

/** Feeds are re-checked for new episodes at most this often. */
const REFRESH_MS = 30 * 60 * 1000;

function subscriptionsCollection(uid: string) {
  return collection(db, "users", uid, "subscriptions");
}

/** Deterministic id so subscribing twice to the same feed updates one document. */
async function subscriptionId(feedUrl: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(feedUrl.trim()));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function toSubscription(d: QueryDocumentSnapshot<DocumentData>): Subscription {
  return { id: d.id, ...(d.data() as Omit<Subscription, "id">) };
}

export function subscribeSubscriptions(
  uid: string,
  cb: (subs: Subscription[]) => void,
  onError?: (e: Error) => void,
): Unsubscribe {
  const q = query(subscriptionsCollection(uid), orderBy("title"));
  return onSnapshot(q, (snap) => cb(snap.docs.map(toSubscription)), onError);
}

/** Follows a feed. Everything currently in it counts as already seen, so only later episodes show as new. */
export async function subscribe(uid: string, feedUrl: string, feed: FeedResult, language: string): Promise<string> {
  const id = await subscriptionId(feedUrl);
  const { latestAt } = feedStats(feed.episodes, 0);
  await setDoc(doc(subscriptionsCollection(uid), id), {
    feedUrl: feedUrl.trim(),
    title: feed.title,
    image: feed.image ?? null,
    language,
    createdAt: serverTimestamp(),
    lastCheckedAt: serverTimestamp(),
    latestAt,
    seenUpTo: latestAt,
    newCount: 0,
    checkError: null,
  });
  return id;
}

export async function unsubscribe(uid: string, subId: string): Promise<void> {
  await deleteDoc(doc(subscriptionsCollection(uid), subId));
}

export async function setSubscriptionLanguage(uid: string, subId: string, language: string): Promise<void> {
  await updateDoc(doc(subscriptionsCollection(uid), subId), { language });
}

/** Records a fresh copy of the feed; with `markSeen`, everything in it stops counting as new. */
export async function recordFeedCheck(uid: string, sub: Subscription, feed: FeedResult, markSeen: boolean): Promise<void> {
  const { latestAt, newCount } = feedStats(feed.episodes, sub.seenUpTo);
  await updateDoc(doc(subscriptionsCollection(uid), sub.id), {
    title: feed.title,
    image: feed.image ?? null,
    lastCheckedAt: serverTimestamp(),
    latestAt,
    checkError: null,
    ...(markSeen ? { seenUpTo: Math.max(sub.seenUpTo, latestAt), newCount: 0 } : { newCount }),
  });
}

function isStale(sub: Subscription): boolean {
  const checked = sub.lastCheckedAt?.toMillis() ?? 0;
  return Date.now() - checked > REFRESH_MS;
}

/** Fetches every subscription not checked recently and updates its new-episode count. */
export async function refreshStaleSubscriptions(uid: string, subs: Subscription[]): Promise<void> {
  await Promise.allSettled(
    subs.filter(isStale).map(async (sub) => {
      try {
        await recordFeedCheck(uid, sub, await fetchFeed(sub.feedUrl), false);
      } catch (e) {
        await updateDoc(doc(subscriptionsCollection(uid), sub.id), {
          lastCheckedAt: serverTimestamp(),
          checkError: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        });
      }
    }),
  );
}
