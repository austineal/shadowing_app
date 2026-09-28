/// <reference lib="webworker" />
// Throwaway benchmark: runs Piper voices in a worker and reports timings.
import { PiperVoice } from "../lib/piper/runner";

export type WorkerIn = { type: "run"; voiceId: string; texts: string[] };
export type WorkerOut =
  | { type: "progress"; voiceId: string; loaded: number; total: number }
  | { type: "loaded"; voiceId: string; ms: number }
  | {
      type: "result";
      voiceId: string;
      index: number;
      ms: number;
      phonemeMs: number;
      inferMs: number;
      pcm: Float32Array;
      sampleRate: number;
    }
  | { type: "error"; voiceId: string; message: string }
  | { type: "done"; voiceId: string };

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const { voiceId, texts } = e.data;
  try {
    const t0 = performance.now();
    const voice = await PiperVoice.load(voiceId, (loaded, total) => post({ type: "progress", voiceId, loaded, total }));
    post({ type: "loaded", voiceId, ms: performance.now() - t0 });
    for (let i = 0; i < texts.length; i++) {
      const t = performance.now();
      const s = await voice.synthesize(texts[i]);
      post(
        {
          type: "result",
          voiceId,
          index: i,
          ms: performance.now() - t,
          phonemeMs: s.phonemeMs,
          inferMs: s.inferMs,
          pcm: s.pcm,
          sampleRate: s.sampleRate,
        },
        [s.pcm.buffer],
      );
    }
    post({ type: "done", voiceId });
  } catch (err) {
    post({ type: "error", voiceId, message: err instanceof Error ? err.message : String(err) });
  }
};
