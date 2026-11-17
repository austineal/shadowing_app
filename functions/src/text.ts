import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { randomUUID } from "node:crypto";
import { db, bucket } from "./admin.js";
import { REGION, elevenLabsApiKey, ttsModelId } from "./config.js";
import { chunkText, speak } from "./elevenlabs.js";
import { toCbrMp3 } from "./audio.js";
import { assertAllowed } from "./auth.js";

/**
 * The ElevenLabs voice that reads each language, keyed by the app's language code. Text import is
 * offered only for these languages: keep TTS_LANGUAGES in web/src/pages/Import.tsx in step.
 */
const VOICES: Record<string, string> = {
  no: "SAa140Q9akujSiZCBSNt",
  fr: "6DEjyaHWnTHsvXM5Byys",
  cy: "ynTHHllfDmGsZ3G8QJt9",
  ja: "YtLXDp1ffXOa1EhXx19q",
};

/** Longest text accepted: roughly 20 minutes of speech, and a bounded ElevenLabs bill per import. */
const MAX_TEXT_CHARS = 20_000;
/**
 * Creates an episode from text: ElevenLabs reads it aloud into audio.mp3, which the Storage trigger
 * transcribes like any upload, and the text is kept as the episode's transcript so the phrases show
 * it exactly as written. Returns once the audio is saved; creates nothing if ElevenLabs fails.
 */
export const importText = onCall(
  { region: REGION, memory: "1GiB", timeoutSeconds: 540, secrets: [elevenLabsApiKey] },
  async (req) => {
    const uid = await assertAllowed(req);
    const data = (req.data ?? {}) as Record<string, unknown>;
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!text) throw new HttpsError("invalid-argument", "Text is required.");
    if (text.length > MAX_TEXT_CHARS) {
      throw new HttpsError("invalid-argument", `The text is too long (over ${MAX_TEXT_CHARS.toLocaleString("en")} characters).`);
    }
    const title = typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 300) : "Untitled";
    const language = typeof data.language === "string" ? data.language : "";
    const voiceId = VOICES[language];
    if (!voiceId) throw new HttpsError("invalid-argument", "Text import isn't available for this language yet.");
    const folderId = typeof data.folderId === "string" && /^[A-Za-z0-9]{1,64}$/.test(data.folderId) ? data.folderId : null;

    // Speak the text first, so a refusal from ElevenLabs leaves no half-made episode behind.
    let audio: Buffer;
    try {
      const started = Date.now();
      const parts: Buffer[] = [];
      for (const chunk of chunkText(text)) {
        parts.push(await speak({ apiKey: elevenLabsApiKey.value(), modelId: ttsModelId.value(), voiceId, languageCode: language, text: chunk }));
      }
      // One clean CBR file from the joined pieces, so seeking lands exactly.
      audio = await toCbrMp3(Buffer.concat(parts));
      logger.info("Spoke text", { chars: text.length, requests: parts.length, ms: Date.now() - started, bytes: audio.length });
    } catch (err) {
      logger.error("Text-to-speech failed", { err: String(err) });
      throw new HttpsError("unavailable", `Couldn't create the audio: ${String(err instanceof Error ? err.message : err).slice(0, 500)}`);
    }

    const episodeRef = db.collection(`users/${uid}/episodes`).doc();
    const episodeId = episodeRef.id;
    const dir = `users/${uid}/episodes/${episodeId}`;
    const audioPath = `${dir}/audio.mp3`;
    const transcriptPath = `${dir}/transcript.txt`;

    await bucket.file(transcriptPath).save(text, { contentType: "text/plain; charset=utf-8", resumable: false });
    await episodeRef.set({
      title,
      language,
      status: "uploading",
      source: "text",
      folderId,
      audioPath,
      transcriptPath,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    // Saving the audio fires the transcription trigger, which needs the episode to exist.
    await bucket.file(audioPath).save(audio, {
      contentType: "audio/mpeg",
      resumable: false,
      metadata: { metadata: { uid, episodeId, firebaseStorageDownloadTokens: randomUUID() } },
    });

    return { episodeId };
  },
);
