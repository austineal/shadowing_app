/**
 * English clips kept on the device, so drill sessions don't synthesise the same English again
 * every time. Clips live in Cache Storage as 16-bit PCM (half the size of the voice's float
 * output), keyed by voice and text. An index in localStorage records when each was last used and
 * its size; clips unused for KEEP_DAYS are deleted, and so are the least recently used ones when
 * the store outgrows MAX_BYTES. A clip that's needed again is simply made again.
 */
import { DAY_MS } from "../drill/srs";
import { synthesize, toAudioBuffer } from "./client";

const CLIP_CACHE = "tts-clips";
const INDEX_KEY = "shadowing.ttsClips";
const PRUNED_KEY = "shadowing.ttsClipsPruned";
/** Clips not used for this long are deleted. */
const KEEP_DAYS = 60;
/** Past this size, the least recently used clips go until the store is down to TARGET_BYTES. */
const MAX_BYTES = 150 * 1024 * 1024;
const TARGET_BYTES = 120 * 1024 * 1024;

/** Last day of use (days since 1970) and size in bytes, by cache path. */
type ClipIndex = Record<string, { used: number; bytes: number }>;

export function toInt16(pcm: Float32Array): Int16Array {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, pcm[i])) * 0x7fff);
  return out;
}

export function toFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x7fff;
  return out;
}

/**
 * Paths of clips to delete: those last used more than `keepDays` before `today`, then, if the rest
 * come to more than `maxBytes`, the least recently used until they're down to `targetBytes`.
 */
export function clipsToDelete(
  index: ClipIndex,
  today: number,
  keepDays = KEEP_DAYS,
  maxBytes = MAX_BYTES,
  targetBytes = TARGET_BYTES,
): string[] {
  const entries = Object.entries(index);
  const stale = entries.filter(([, e]) => today - e.used > keepDays).map(([path]) => path);
  const kept = entries.filter(([, e]) => today - e.used <= keepDays).sort((a, b) => a[1].used - b[1].used);
  let total = kept.reduce((sum, [, e]) => sum + e.bytes, 0);
  if (total <= maxBytes) return stale;
  const evicted: string[] = [];
  for (const [path, e] of kept) {
    if (total <= targetBytes) break;
    evicted.push(path);
    total -= e.bytes;
  }
  return [...stale, ...evicted];
}

const today = () => Math.floor(Date.now() / DAY_MS);

let index: ClipIndex | undefined;
let flushTimer: number | undefined;

function loadIndex(): ClipIndex {
  if (index) return index;
  try {
    index = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "{}") as ClipIndex;
  } catch {
    index = {};
  }
  return index;
}

function saveIndex() {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(loadIndex()));
  } catch {
    /* full or unavailable: pruning just knows less */
  }
}

/** Records a use, writing the index a moment later so a batch of clips costs one write. */
function touch(path: string, bytes: number) {
  const idx = loadIndex();
  const day = today();
  const e = idx[path];
  if (e && e.used === day && e.bytes === bytes) return;
  idx[path] = { used: day, bytes };
  if (flushTimer === undefined) {
    flushTimer = window.setTimeout(() => {
      flushTimer = undefined;
      saveIndex();
    }, 500);
  }
}

async function pathFor(voiceId: string, text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${voiceId}\n${text}`));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `/__tts/${voiceId}/${hex.slice(0, 32)}`;
}

const supported = () => typeof caches !== "undefined";

async function store(path: string, buf: AudioBuffer): Promise<void> {
  const pcm = toInt16(buf.getChannelData(0));
  const cache = await caches.open(CLIP_CACHE);
  await cache.put(
    path,
    new Response(pcm.buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Sample-Rate": String(buf.sampleRate),
        "X-Bytes": String(pcm.byteLength),
      },
    }),
  );
  touch(path, pcm.byteLength);
}

/** A stored clip, or undefined if there isn't one. */
async function storedClip(voiceId: string, text: string): Promise<AudioBuffer | undefined> {
  if (!supported()) return undefined;
  const path = await pathFor(voiceId, text);
  const res = await (await caches.open(CLIP_CACHE)).match(path);
  if (!res) return undefined;
  const pcm = toFloat32(new Int16Array(await res.arrayBuffer()));
  touch(path, pcm.length * 2);
  return toAudioBuffer(pcm, Number(res.headers.get("X-Sample-Rate")) || 22050);
}

/** The English clip for a text: stored on this device, or synthesised now and stored. */
export async function englishClip(voiceId: string, text: string): Promise<AudioBuffer> {
  const have = await storedClip(voiceId, text).catch(() => undefined);
  if (have) return have;
  const buf = await synthesize(voiceId, text);
  if (supported()) await store(await pathFor(voiceId, text), buf).catch(() => undefined); // out of space: still play it
  return buf;
}

/** Makes sure a clip is stored, synthesising it if not. Returns whether it had to be made. */
export async function ensureClip(voiceId: string, text: string): Promise<boolean> {
  if (!supported()) return false;
  const path = await pathFor(voiceId, text);
  const cache = await caches.open(CLIP_CACHE);
  const have = await cache.match(path);
  if (have) {
    touch(path, Number(have.headers.get("X-Bytes")) || (loadIndex()[path]?.bytes ?? 0));
    return false;
  }
  await store(path, await synthesize(voiceId, text));
  return true;
}

/** Deletes clips unused for KEEP_DAYS, and the least used past MAX_BYTES. At most once a day; returns how many went. */
export async function pruneClips(): Promise<number> {
  if (!supported()) return 0;
  const day = today();
  try {
    if (Number(localStorage.getItem(PRUNED_KEY)) === day) return 0;
    localStorage.setItem(PRUNED_KEY, String(day));
  } catch {
    /* prune anyway */
  }
  const cache = await caches.open(CLIP_CACHE);
  const paths = (await cache.keys()).map((r) => new URL(r.url).pathname);
  const idx = loadIndex();
  // Bring the index in line with what's actually stored: clips it doesn't know count as used today.
  for (const p of paths) idx[p] ??= { used: day, bytes: 0 };
  const present = new Set(paths);
  for (const p of Object.keys(idx)) if (!present.has(p)) delete idx[p];
  const doomed = clipsToDelete(idx, day);
  await Promise.all(doomed.map((p) => cache.delete(p)));
  for (const p of doomed) delete idx[p];
  saveIndex();
  return doomed.length;
}

/** Bytes of stored clips, as far as the index knows. */
export function storedClipBytes(): number {
  return Object.values(loadIndex()).reduce((sum, e) => sum + e.bytes, 0);
}

export async function clearClips(): Promise<void> {
  if (supported()) await caches.delete(CLIP_CACHE);
  index = {};
  saveIndex();
}
