import { useEffect, useState } from "react";
import { app } from "../firebase";

/**
 * Offline support.
 *
 * - The service worker (see vite.config.ts) serves audio from the "audio-files"
 *   cache with range-request support, and word-timing JSON from "episode-data".
 * - This module fills those caches explicitly when the user saves an episode for
 *   offline use, and reads "episode-data" as a fallback when the Storage SDK
 *   cannot reach the network.
 */

export const AUDIO_CACHE = "audio-files";
export const DATA_CACHE = "episode-data";

export function cacheSupported(): boolean {
  return typeof caches !== "undefined" && typeof Response !== "undefined";
}

/** React hook: current navigator.onLine state. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/** The URL the Firebase Storage SDK uses to download an object; also the service worker's cache key. */
export function storageMediaUrl(path: string): string {
  const bucket = app.options.storageBucket ?? "";
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}?alt=media`;
}

export async function isAudioCached(url: string | undefined): Promise<boolean> {
  if (!url || !cacheSupported()) return false;
  const cache = await caches.open(AUDIO_CACHE);
  return (await cache.match(url)) !== undefined;
}

export type ProgressFn = (loaded: number, total: number) => void;

/** Downloads the full audio file and stores it so the service worker can serve it offline. */
export async function cacheAudio(url: string, onProgress?: ProgressFn, signal?: AbortSignal): Promise<void> {
  if (!cacheSupported()) throw new Error("This browser does not support offline caching.");
  const cache = await caches.open(AUDIO_CACHE);
  if (await cache.match(url)) return;

  try {
    await navigator.storage?.persist?.();
  } catch {
    /* best effort */
  }

  const res = await fetch(url, { signal });
  if (res.status !== 200 || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const contentType = res.headers.get("content-type") ?? "audio/mpeg";

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }
  const blob = new Blob(chunks as BlobPart[], { type: contentType });

  // The service worker may already have stored this response as it passed through.
  if (await cache.match(url)) return;
  await cache.put(
    url,
    new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(blob.size),
        "Accept-Ranges": "bytes",
      },
    }),
  );
}

export async function removeCachedAudio(url: string | undefined): Promise<void> {
  if (!url || !cacheSupported()) return;
  const cache = await caches.open(AUDIO_CACHE);
  await cache.delete(url);
}

export async function cachedText(url: string): Promise<string | null> {
  if (!cacheSupported()) return null;
  const cache = await caches.open(DATA_CACHE);
  const res = await cache.match(url);
  return res ? res.text() : null;
}

export async function putCachedText(url: string, text: string, contentType = "application/json"): Promise<void> {
  if (!cacheSupported()) return;
  const cache = await caches.open(DATA_CACHE);
  await cache.put(url, new Response(text, { status: 200, headers: { "Content-Type": contentType } }));
}

export async function removeCachedText(url: string): Promise<void> {
  if (!cacheSupported()) return;
  const cache = await caches.open(DATA_CACHE);
  await cache.delete(url);
}

/** Bytes used by this origin's storage (caches, IndexedDB), if the browser reports it. */
export async function storageUsage(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return null;
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}
