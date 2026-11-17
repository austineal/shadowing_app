/** Minimal client for the ElevenLabs speech-to-text ("Scribe") endpoint. */

interface ScribeWord {
  text: string;
  start: number;
  end: number;
  type: "word" | "spacing" | "audio_event";
  speaker_id?: string;
  logprob?: number;
}

interface ScribeResult {
  language_code: string;
  language_probability: number;
  text: string;
  words: ScribeWord[];
}

interface TranscribeOptions {
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


/** ElevenLabs text-to-speech: returns MP3 bytes for one request's worth of text. */
export async function speak(opts: { apiKey: string; modelId: string; voiceId: string; languageCode: string; text: string }): Promise<Buffer> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text: opts.text, model_id: opts.modelId, language_code: opts.languageCode }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs text-to-speech failed (${res.status}): ${body.slice(0, 500)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Characters per text-to-speech request, well under the model's per-request limit. */
const CHUNK_CHARS = 2_500;

/** Splits text into pieces of at most `max` characters, breaking between sentences where it can. */
export function chunkText(text: string, max = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = (piece: string) => {
    if (current && current.length + piece.length > max) {
      chunks.push(current.trim());
      current = "";
    }
    current += piece;
  };
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)) {
    if (segment.length <= max) {
      push(segment);
      continue;
    }
    // A sentence too long for one request: break it between words, or anywhere if it has no spaces.
    for (const word of segment.match(/\S+\s*|\s+/g) ?? []) {
      for (let i = 0; i < word.length; i += max) push(word.slice(i, i + max));
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}
