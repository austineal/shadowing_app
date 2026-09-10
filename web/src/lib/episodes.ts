import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import {
  deleteObject,
  getBytes,
  getDownloadURL,
  listAll,
  ref,
  uploadBytes,
  uploadBytesResumable,
  uploadString,
} from "firebase/storage";
import { httpsCallable } from "firebase/functions";
import { db, functions, storage } from "../firebase";
import {
  cacheAudio,
  cachedText,
  putCachedText,
  removeCachedAudio,
  removeCachedText,
  storageMediaUrl,
  type ProgressFn,
} from "./offline";
import type { Episode, PracticeSettings, Segment, SegmentsDoc, TimedToken, WordsFile } from "../types";

export function episodesCollection(uid: string) {
  return collection(db, "users", uid, "episodes");
}

export function episodeDoc(uid: string, episodeId: string) {
  return doc(db, "users", uid, "episodes", episodeId);
}

export function segmentsDoc(uid: string, episodeId: string) {
  return doc(db, "users", uid, "episodes", episodeId, "data", "segments");
}

function toEpisode(snap: QueryDocumentSnapshot<DocumentData> | { id: string; data: () => DocumentData | undefined }): Episode {
  const d = snap.data() ?? {};
  return { id: snap.id, ...(d as Omit<Episode, "id">) };
}

export function subscribeEpisodes(uid: string, cb: (episodes: Episode[]) => void, onError?: (e: Error) => void): Unsubscribe {
  const q = query(episodesCollection(uid), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => cb(snap.docs.map(toEpisode)), onError);
}

export function subscribeEpisode(
  uid: string,
  episodeId: string,
  cb: (episode: Episode | null) => void,
  onError?: (e: Error) => void,
): Unsubscribe {
  return onSnapshot(
    episodeDoc(uid, episodeId),
    (snap) => cb(snap.exists() ? toEpisode({ id: snap.id, data: () => snap.data() }) : null),
    onError,
  );
}

export function subscribeSegments(
  uid: string,
  episodeId: string,
  cb: (docData: SegmentsDoc | null) => void,
  onError?: (e: Error) => void,
): Unsubscribe {
  return onSnapshot(
    segmentsDoc(uid, episodeId),
    (snap) => cb(snap.exists() ? (snap.data() as SegmentsDoc) : null),
    onError,
  );
}

export async function saveSegments(uid: string, episodeId: string, data: Omit<SegmentsDoc, "updatedAt">): Promise<void> {
  await setDoc(segmentsDoc(uid, episodeId), { ...data, updatedAt: serverTimestamp() });
}

export async function updateSegmentList(uid: string, episodeId: string, segments: Segment[]): Promise<void> {
  await updateDoc(segmentsDoc(uid, episodeId), { segments, updatedAt: serverTimestamp() });
}

export async function updateEpisode(uid: string, episodeId: string, patch: Partial<Episode> & Record<string, unknown>): Promise<void> {
  await updateDoc(episodeDoc(uid, episodeId), { ...patch, updatedAt: serverTimestamp() });
}

export async function saveEpisodeSettings(uid: string, episodeId: string, settings: PracticeSettings): Promise<void> {
  await updateDoc(episodeDoc(uid, episodeId), { settings });
}

export interface UploadParams {
  file: File;
  title: string;
  language: string;
  transcriptText?: string;
  onProgress?: (fraction: number) => void;
}

function extensionOf(file: File): string {
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(file.name);
  if (m) return m[1].toLowerCase();
  if (file.type === "audio/mpeg") return "mp3";
  if (file.type === "audio/mp4" || file.type === "audio/x-m4a") return "m4a";
  return "mp3";
}

/** Creates the episode document, uploads the audio (and optional transcript), and hands off to the transcription trigger. */
export async function uploadEpisode(uid: string, params: UploadParams): Promise<string> {
  const episodeRef = doc(episodesCollection(uid));
  const episodeId = episodeRef.id;
  const ext = extensionOf(params.file);
  const audioPath = `users/${uid}/episodes/${episodeId}/audio.${ext}`;
  const transcriptPath = params.transcriptText?.trim() ? `users/${uid}/episodes/${episodeId}/transcript.txt` : undefined;

  await setDoc(episodeRef, {
    title: params.title.trim() || params.file.name,
    language: params.language,
    status: "uploading",
    source: "upload",
    audioPath,
    ...(transcriptPath ? { transcriptPath } : {}),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  if (transcriptPath) {
    await uploadString(ref(storage, transcriptPath), params.transcriptText!, "raw", { contentType: "text/plain; charset=utf-8" });
  }

  await new Promise<void>((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, audioPath), params.file, {
      contentType: params.file.type || "audio/mpeg",
      customMetadata: { uid, episodeId },
    });
    task.on(
      "state_changed",
      (s) => params.onProgress?.(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0),
      reject,
      () => resolve(),
    );
  });

  // Signal completion, but never clobber a state the transcription function has already set.
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(episodeRef);
    if (snap.exists() && snap.get("status") === "uploading") {
      tx.update(episodeRef, { status: "uploaded", updatedAt: serverTimestamp() });
    }
  });

  return episodeId;
}

/** Attaches (or replaces) a user transcript for an existing episode. */
export async function saveTranscript(uid: string, episodeId: string, text: string): Promise<string> {
  const transcriptPath = `users/${uid}/episodes/${episodeId}/transcript.txt`;
  await uploadString(ref(storage, transcriptPath), text, "raw", { contentType: "text/plain; charset=utf-8" });
  await updateEpisode(uid, episodeId, { transcriptPath });
  return transcriptPath;
}

/**
 * Reads a text/JSON object from Storage. Falls back to the offline cache when the
 * network (or the auth token refresh it needs) is unavailable.
 */
export async function loadText(path: string): Promise<string> {
  const key = storageMediaUrl(path);
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    const cached = await cachedText(key);
    if (cached !== null) return cached;
  }
  try {
    const bytes = await getBytes(ref(storage, path));
    const text = new TextDecoder().decode(bytes);
    void putCachedText(key, text).catch(() => undefined);
    return text;
  } catch (err) {
    const cached = await cachedText(key);
    if (cached !== null) return cached;
    throw err;
  }
}

export async function loadWordsFile(path: string): Promise<WordsFile> {
  return JSON.parse(await loadText(path)) as WordsFile;
}

export async function loadTokens(path: string): Promise<TimedToken[]> {
  const json = JSON.parse(await loadText(path)) as WordsFile | TimedToken[];
  return Array.isArray(json) ? json : json.words;
}

export async function saveAlignedTokens(uid: string, episodeId: string, tokens: TimedToken[]): Promise<string> {
  const path = `users/${uid}/episodes/${episodeId}/aligned.json`;
  await uploadBytes(ref(storage, path), new Blob([JSON.stringify(tokens)], { type: "application/json" }));
  return path;
}

/** Returns the audio download URL, persisting it on the episode so later (offline) opens need no lookup. */
export async function ensureAudioUrl(uid: string, episode: Episode): Promise<string> {
  if (episode.audioUrl) return episode.audioUrl;
  const url = await getDownloadURL(ref(storage, episode.audioPath));
  await updateEpisode(uid, episode.id, { audioUrl: url }).catch(() => undefined);
  return url;
}

/** Downloads the audio and the word timings the episode depends on into the offline caches. */
export async function cacheEpisodeForOffline(
  uid: string,
  episode: Episode,
  url: string,
  onProgress?: ProgressFn,
): Promise<void> {
  await cacheAudio(url, onProgress);
  // Word timings: words.json always (needed to build phrases), plus aligned.json if phrases came from a transcript.
  const paths = new Set<string>();
  if (episode.wordsPath) paths.add(episode.wordsPath);
  const seg = await getDoc(segmentsDoc(uid, episode.id)).catch(() => null);
  const tokensPath = seg?.exists() ? (seg.data() as SegmentsDoc).tokensPath : undefined;
  if (tokensPath) paths.add(tokensPath);
  for (const p of paths) {
    await loadText(p).catch(() => undefined); // loadText writes through to the cache
  }
}

export async function removeEpisodeOfflineData(uid: string, episode: Episode): Promise<void> {
  await removeCachedAudio(episode.audioUrl);
  for (const p of [episode.wordsPath, `users/${uid}/episodes/${episode.id}/aligned.json`]) {
    if (p) await removeCachedText(storageMediaUrl(p)).catch(() => undefined);
  }
}

export async function deleteEpisode(uid: string, episode: Episode): Promise<void> {
  const episodeId = episode.id;
  await removeEpisodeOfflineData(uid, episode).catch(() => undefined);
  const folder = ref(storage, `users/${uid}/episodes/${episodeId}`);
  const listing = await listAll(folder).catch(() => ({ items: [] as ReturnType<typeof ref>[] }));
  await Promise.all(listing.items.map((item) => deleteObject(item).catch(() => undefined)));
  await deleteDoc(segmentsDoc(uid, episodeId)).catch(() => undefined);
  await deleteDoc(episodeDoc(uid, episodeId));
}

export async function getEpisodeOnce(uid: string, episodeId: string): Promise<Episode | null> {
  const snap = await getDoc(episodeDoc(uid, episodeId));
  return snap.exists() ? toEpisode({ id: snap.id, data: () => snap.data() }) : null;
}

// ---- Cloud Functions ----

export interface FeedEpisode {
  title: string;
  audioUrl: string;
  mimeType?: string;
  pubDate?: string;
  durationSec?: number;
  description?: string;
}

export interface FeedResult {
  title: string;
  language?: string;
  image?: string;
  episodes: FeedEpisode[];
}

const fetchFeedFn = httpsCallable<{ url: string }, FeedResult>(functions, "fetchFeed");
const importEpisodeFn = httpsCallable<
  { audioUrl: string; title: string; language: string; feedTitle?: string; feedUrl?: string },
  { episodeId: string }
>(functions, "importEpisode");
const retranscribeFn = httpsCallable<{ episodeId: string }, { status: string; error: string | null }>(functions, "retranscribeEpisode");

export async function fetchFeed(url: string): Promise<FeedResult> {
  return (await fetchFeedFn({ url })).data;
}

export async function importFeedEpisode(params: {
  audioUrl: string;
  title: string;
  language: string;
  feedTitle?: string;
  feedUrl?: string;
}): Promise<string> {
  return (await importEpisodeFn(params)).data.episodeId;
}

export async function retranscribe(episodeId: string): Promise<{ status: string; error: string | null }> {
  return (await retranscribeFn({ episodeId })).data;
}
