import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { db, bucket } from "./admin.js";
import { REGION, elevenLabsApiKey, scribeModelId } from "./config.js";
import { transcribeAudio } from "./elevenlabs.js";
import { assertAllowed } from "./auth.js";

const AUDIO_PATH_RE = /^users\/([^/]+)\/episodes\/([^/]+)\/audio\.([A-Za-z0-9]+)$/;

/** Statuses from which a transcription run may claim the episode. */
const CLAIMABLE = new Set(["uploading", "uploaded", "error"]);

/**
 * Transcribes the audio for one episode and writes words.json to Storage.
 * Idempotent: only one run claims the episode; others exit early.
 */
export async function runTranscription(uid: string, episodeId: string, audioPath: string): Promise<void> {
  const ref = db.doc(`users/${uid}/episodes/${episodeId}`);

  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data()!;
    if (!CLAIMABLE.has(data.status)) return null;
    tx.update(ref, {
      status: "transcribing",
      error: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return data;
  });

  if (!claimed) {
    logger.info("Episode not claimable, skipping", { uid, episodeId });
    return;
  }

  try {
    const file = bucket.file(audioPath);
    const [meta] = await file.getMetadata();
    const contentType = (meta.contentType as string | undefined) ?? "audio/mpeg";
    logger.info("Downloading audio", { audioPath, size: meta.size, contentType });
    const [audio] = await file.download();

    const language: string | undefined =
      claimed.language && claimed.language !== "auto" ? claimed.language : undefined;

    logger.info("Calling ElevenLabs", { modelId: scribeModelId.value(), language, bytes: audio.length });
    const started = Date.now();
    const result = await transcribeAudio({
      apiKey: elevenLabsApiKey.value(),
      modelId: scribeModelId.value(),
      audio,
      filename: audioPath.split("/").pop() ?? "audio",
      contentType,
      languageCode: language,
    });
    logger.info("Transcription complete", {
      ms: Date.now() - started,
      words: result.words.length,
      detected: result.language_code,
    });

    const wordsPath = `users/${uid}/episodes/${episodeId}/words.json`;
    await bucket.file(wordsPath).save(JSON.stringify(result), {
      contentType: "application/json",
      resumable: false,
    });

    let durationSec = 0;
    let wordCount = 0;
    for (const w of result.words) {
      if (w.end > durationSec) durationSec = w.end;
      if (w.type === "word") wordCount++;
    }

    await ref.update({
      status: "ready",
      wordsPath,
      detectedLanguage: result.language_code,
      languageProbability: result.language_probability,
      durationSec,
      wordCount,
      transcribedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.error("Transcription failed", { uid, episodeId, err: String(err) });
    await ref.update({
      status: "error",
      error: String(err instanceof Error ? err.message : err).slice(0, 1000),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
}

/** Fires when an episode's audio file lands in Storage. */
export const transcribeOnUpload = onObjectFinalized(
  {
    region: REGION,
    memory: "2GiB",
    cpu: 1,
    timeoutSeconds: 540,
    secrets: [elevenLabsApiKey],
    retry: false,
  },
  async (event) => {
    const name = event.data.name;
    const m = AUDIO_PATH_RE.exec(name);
    if (!m) return;
    const [, uid, episodeId] = m;
    await runTranscription(uid, episodeId, name);
  },
);

/** Manual retry from the client, e.g. after an API error. Runs synchronously. */
export const retranscribeEpisode = onCall(
  {
    region: REGION,
    memory: "2GiB",
    cpu: 1,
    timeoutSeconds: 540,
    secrets: [elevenLabsApiKey],
  },
  async (req) => {
    const uid = assertAllowed(req);
    const episodeId = (req.data as { episodeId?: unknown })?.episodeId;
    if (typeof episodeId !== "string" || !episodeId) {
      throw new HttpsError("invalid-argument", "episodeId is required.");
    }
    const ref = db.doc(`users/${uid}/episodes/${episodeId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Episode not found.");
    const data = snap.data()!;
    if (typeof data.audioPath !== "string") {
      throw new HttpsError("failed-precondition", "Episode has no audio.");
    }
    if (data.status === "transcribing") {
      throw new HttpsError("failed-precondition", "Transcription already in progress.");
    }
    // Allow re-running even from 'ready' so a language change can be applied.
    await ref.update({ status: "uploaded", updatedAt: FieldValue.serverTimestamp() });
    await runTranscription(uid, episodeId, data.audioPath);
    const after = await ref.get();
    return { status: after.get("status"), error: after.get("error") ?? null };
  },
);
