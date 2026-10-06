/**
 * On-device text-to-speech. Piper voices run in a shared worker thread (see worker.ts); voice
 * models are downloaded once into Cache Storage and then work offline.
 */
import { VOICE_CACHE, voiceModelUrl, type ProgressFn } from "../piper/runner";
import type { TtsRequest, TtsResponse } from "./worker";

/** Voices offered for English. Medium quality: fast enough on a phone (~0.4x real time). */
export const ENGLISH_VOICES = [
  { id: "en_GB-alba-medium", label: "Alba (British, female)" },
  { id: "en_GB-cori-medium", label: "Cori (British, female)" },
  { id: "en_US-lessac-medium", label: "Lessac (American, female)" },
  { id: "en_GB-northern_english_male-medium", label: "Northern English (male)" },
  { id: "en_US-ryan-medium", label: "Ryan (American, male)" },
] as const;

export const DEFAULT_ENGLISH_VOICE = ENGLISH_VOICES[0].id;

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (r: Extract<TtsResponse, { type: "done" }>) => void; reject: (e: Error) => void; onProgress?: ProgressFn }
>();

/** A worker that has sent nothing for this long while requests are outstanding is treated as hung. */
const STALL_MS = 30_000;
let lastHeard = 0;
let watchdog: number | undefined;

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** Drops the worker and fails everything waiting on it; the next request starts a new one. */
function restartWorker(reason: string) {
  worker?.terminate();
  worker = undefined;
  window.clearInterval(watchdog);
  watchdog = undefined;
  const waiting = [...pending.values()];
  pending.clear();
  for (const p of waiting) p.reject(new Error(reason));
}

function send(req: WithoutId<TtsRequest>, onProgress?: ProgressFn) {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<TtsResponse>) => {
      lastHeard = performance.now();
      const m = e.data;
      const p = pending.get(m.id);
      if (!p) return;
      if (m.type === "progress") p.onProgress?.(m.loaded, m.total);
      else {
        pending.delete(m.id);
        if (m.type === "done") p.resolve(m);
        else p.reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => restartWorker(`Speech worker crashed: ${e.message}`);
    watchdog = window.setInterval(() => {
      if (pending.size > 0 && performance.now() - lastHeard > STALL_MS) restartWorker("Speech worker stopped responding.");
    }, 5_000);
  }
  if (pending.size === 0) lastHeard = performance.now();
  const id = nextId++;
  return new Promise<Extract<TtsResponse, { type: "done" }>>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker!.postMessage({ ...req, id } as TtsRequest);
  });
}

/** Downloads (if needed) and loads a voice. */
export async function loadVoice(voiceId: string, onProgress?: ProgressFn): Promise<void> {
  await send({ type: "load", voiceId }, onProgress);
}

/** Whether the voice's model is already on this device. */
export async function isVoiceStored(voiceId: string): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  const cache = await caches.open(VOICE_CACHE);
  return (await cache.match(voiceModelUrl(voiceId))) !== undefined;
}

/** A mono AudioBuffer holding the samples. */
export function toAudioBuffer(pcm: Float32Array, sampleRate: number): AudioBuffer {
  const buf = new AudioBuffer({ length: Math.max(1, pcm.length), sampleRate, numberOfChannels: 1 });
  buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
  return buf;
}

export async function synthesize(voiceId: string, text: string): Promise<AudioBuffer> {
  const r = await send({ type: "synth", voiceId, text });
  return toAudioBuffer(r.pcm!, r.sampleRate!);
}
