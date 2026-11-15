/**
 * Where Piper voices live. Kept apart from runner.ts so the app can check for a stored voice
 * without loading the speech runtime, which only the worker needs.
 */
const VOICES_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";
export const VOICE_CACHE = "piper-voices";

export type ProgressFn = (loaded: number, total: number) => void;

/** e.g. en_GB-alba-medium -> en/en_GB/alba/medium/en_GB-alba-medium */
function voicePath(voiceId: string): string {
  const [locale, name, quality] = voiceId.split("-");
  return `${locale.split("_")[0]}/${locale}/${name}/${quality}/${voiceId}`;
}

/** URL of a voice's .onnx model (its config is the same URL plus .json). Also its cache key. */
export function voiceModelUrl(voiceId: string): string {
  return `${VOICES_BASE}/${voicePath(voiceId)}.onnx`;
}
