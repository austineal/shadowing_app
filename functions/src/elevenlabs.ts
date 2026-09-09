/** Minimal client for the ElevenLabs speech-to-text ("Scribe") endpoint. */

export interface ScribeWord {
  text: string;
  start: number;
  end: number;
  type: "word" | "spacing" | "audio_event";
  speaker_id?: string;
  logprob?: number;
}

export interface ScribeResult {
  language_code: string;
  language_probability: number;
  text: string;
  words: ScribeWord[];
}

export interface TranscribeOptions {
  apiKey: string;
  modelId: string;
  audio: Buffer;
  filename: string;
  contentType: string;
  /** ISO-639-1 or ISO-639-3 code. Omit for auto-detect. */
  languageCode?: string;
}

const ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";

export async function transcribeAudio(opts: TranscribeOptions): Promise<ScribeResult> {
  const form = new FormData();
  form.append("model_id", opts.modelId);
  form.append(
    "file",
    new Blob([new Uint8Array(opts.audio)], { type: opts.contentType }),
    opts.filename,
  );
  if (opts.languageCode) form.append("language_code", opts.languageCode);
  form.append("timestamps_granularity", "word");
  form.append("tag_audio_events", "false");
  form.append("diarize", "false");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "xi-api-key": opts.apiKey },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs speech-to-text failed (${res.status}): ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as ScribeResult;
  if (!Array.isArray(json.words)) {
    throw new Error("ElevenLabs response did not include word timestamps.");
  }
  return json;
}
