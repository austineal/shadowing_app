/// <reference lib="webworker" />
// Runs Piper voices off the main thread. Requests are handled one at a time.
import { PiperVoice } from "../piper/runner";

export type TtsRequest = { id: number; type: "load"; voiceId: string } | { id: number; type: "synth"; voiceId: string; text: string };
export type TtsResponse =
  | { id: number; type: "progress"; loaded: number; total: number }
  | { id: number; type: "done"; pcm?: Float32Array; sampleRate?: number }
  | { id: number; type: "error"; message: string };

const post = (m: TtsResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

const voices = new Map<string, Promise<PiperVoice>>();
let queue: Promise<unknown> = Promise.resolve();

function voice(voiceId: string, id: number): Promise<PiperVoice> {
  let v = voices.get(voiceId);
  if (!v) {
    v = PiperVoice.load(voiceId, (loaded, total) => post({ id, type: "progress", loaded, total }));
    v.catch(() => voices.delete(voiceId));
    voices.set(voiceId, v);
  }
  return v;
}

self.onmessage = (e: MessageEvent<TtsRequest>) => {
  const req = e.data;
  queue = queue.then(async () => {
    try {
      const v = await voice(req.voiceId, req.id);
      if (req.type === "load") {
        post({ id: req.id, type: "done" });
        return;
      }
      const { pcm, sampleRate } = await v.synthesize(req.text);
      post({ id: req.id, type: "done", pcm, sampleRate }, [pcm.buffer]);
    } catch (err) {
      post({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  });
};
