/**
 * Piper text-to-speech in the browser: espeak-ng phonemisation (WASM) plus the voice's VITS model
 * on onnxruntime-web. Meant to run in a Web Worker. The phonemiser is instantiated once per
 * worker and each voice's model once, then reused; voice files are kept in Cache Storage so later
 * sessions (and offline use) skip the download.
 */
import * as ort from "onnxruntime-web/wasm";
import { createPiperPhonemize, type PiperPhonemizeModule } from "./phonemize.js";

/** Must match the onnxruntime-web version in package.json. */
const ORT_WASM_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
const PHONEMIZE_BASE = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";
const VOICES_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";
export const VOICE_CACHE = "piper-voices";

interface VoiceConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  num_speakers: number;
}

export type ProgressFn = (loaded: number, total: number) => void;

/** e.g. en_GB-alba-medium -> en/en_GB/alba/medium/en_GB-alba-medium */
export function voicePath(voiceId: string): string {
  const [locale, name, quality] = voiceId.split("-");
  return `${locale.split("_")[0]}/${locale}/${name}/${quality}/${voiceId}`;
}

async function fetchCached(url: string, onProgress?: ProgressFn): Promise<Response> {
  const cache = typeof caches !== "undefined" ? await caches.open(VOICE_CACHE) : undefined;
  const hit = await cache?.match(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const body = new Blob(chunks as BlobPart[]);
  const copy = new Response(body, { headers: { "content-type": res.headers.get("content-type") ?? "" } });
  await cache?.put(url, copy.clone()).catch(() => undefined);
  return copy;
}

let phonemizer: Promise<{ module: PiperPhonemizeModule; lines: string[] }> | undefined;

function getPhonemizer() {
  if (!phonemizer) {
    const state = { lines: [] as string[] };
    phonemizer = createPiperPhonemize({
      print: (line) => state.lines.push(line),
      printErr: (line) => console.warn("[phonemize]", line),
      locateFile: (url) => (url.endsWith(".wasm") ? `${PHONEMIZE_BASE}.wasm` : url.endsWith(".data") ? `${PHONEMIZE_BASE}.data` : url),
    }).then((module) => Object.assign(state, { module }));
  }
  return phonemizer;
}

/** Phoneme id sequences for `text`, one per sentence. */
async function phonemize(text: string, espeakVoice: string): Promise<number[][]> {
  const p = await getPhonemizer();
  p.lines.length = 0;
  p.module.callMain(["-l", espeakVoice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
  return p.lines.map((l) => (JSON.parse(l) as { phoneme_ids: number[] }).phoneme_ids);
}

export interface Speech {
  pcm: Float32Array;
  sampleRate: number;
  phonemeMs: number;
  inferMs: number;
}

export class PiperVoice {
  readonly voiceId: string;
  private readonly config: VoiceConfig;
  private readonly session: ort.InferenceSession;

  private constructor(voiceId: string, config: VoiceConfig, session: ort.InferenceSession) {
    this.voiceId = voiceId;
    this.config = config;
    this.session = session;
  }

  static async load(voiceId: string, onProgress?: ProgressFn): Promise<PiperVoice> {
    ort.env.wasm.wasmPaths = ORT_WASM_BASE;
    // Threads need cross-origin isolation (SharedArrayBuffer); without it ORT runs single-threaded.
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const base = `${VOICES_BASE}/${voicePath(voiceId)}`;
    const config = (await (await fetchCached(`${base}.onnx.json`)).json()) as VoiceConfig;
    const model = await (await fetchCached(`${base}.onnx`, onProgress)).arrayBuffer();
    const [session] = await Promise.all([
      ort.InferenceSession.create(model, { executionProviders: ["wasm"] }),
      getPhonemizer(),
    ]);
    return new PiperVoice(voiceId, config, session);
  }

  /** Synthesises `text`; sentences are joined with a short pause. `lengthScale` > 1 speaks slower. */
  async synthesize(text: string, opts: { lengthScale?: number; pauseSec?: number } = {}): Promise<Speech> {
    const t0 = performance.now();
    const sentences = await phonemize(text, this.config.espeak.voice);
    const t1 = performance.now();
    const { noise_scale, length_scale, noise_w } = this.config.inference;
    const parts: Float32Array[] = [];
    for (const ids of sentences) {
      const feeds: Record<string, ort.Tensor> = {
        input: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
        input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
        scales: new ort.Tensor("float32", Float32Array.from([noise_scale, opts.lengthScale ?? length_scale, noise_w]), [3]),
      };
      if (this.config.num_speakers > 1) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
      const out = await this.session.run(feeds);
      parts.push(out.output.data as Float32Array);
    }
    const sampleRate = this.config.audio.sample_rate;
    const pause = Math.round((opts.pauseSec ?? 0.25) * sampleRate);
    const pcm = new Float32Array(parts.reduce((n, p) => n + p.length, 0) + pause * Math.max(0, parts.length - 1));
    let at = 0;
    parts.forEach((p, i) => {
      pcm.set(p, at);
      at += p.length + (i < parts.length - 1 ? pause : 0);
    });
    return { pcm, sampleRate, phonemeMs: t1 - t0, inferMs: performance.now() - t1 };
  }
}
