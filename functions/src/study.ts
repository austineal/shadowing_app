/**
 * Study mode: translations, study notes and (optionally) English audio for an episode's phrases.
 *
 * Results are stored per phrase text, not per segment, at users/{uid}/phrases/{key} where key
 * hashes the language and normalised text. Segment ids change whenever phrases are split, merged
 * or rebuilt; keying by text means only genuinely new phrases need generating, and a line that
 * recurs across episodes is only done once. Each phrase doc lists the episodes that use it so the
 * client can subscribe to one episode's material with a single query.
 *
 * prepareStudy (callable) works out what is missing and queues the work; studyChunk runs one
 * Claude batch, and englishAudio voices translations. Both are task-queue functions so long
 * episodes don't hit request timeouts and failed batches retry on their own.
 */
import { createHash, randomUUID } from "node:crypto";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { getFunctions } from "firebase-admin/functions";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { db, bucket } from "./admin.js";
import {
  REGION,
  anthropicApiKey,
  claudeModelId,
  elevenLabsApiKey,
  englishVoiceId,
  ttsModelId,
} from "./config.js";
import { assertAllowed } from "./auth.js";
import { CEFR_LEVELS, explain, studyPhrases, type CefrLevel, type StudyNote, type ThreadEntry } from "./claude.js";
import { synthesizeSpeech } from "./elevenlabs.js";

/** Phrases per Claude request. */
const STUDY_BATCH = 25;
/** Translations voiced per englishAudio task. */
const AUDIO_BATCH = 20;

/** Must match phraseKey in web/src/lib/study.ts. */
export function normalizePhrase(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function phraseKey(language: string, text: string): string {
  return createHash("sha256").update(`${language}\n${normalizePhrase(text)}`).digest("hex").slice(0, 32);
}

interface PhraseItem {
  key: string;
  text: string;
}

interface StudyChunkTask {
  uid: string;
  episodeId: string;
  language: string;
  level: CefrLevel;
  items: PhraseItem[];
}

interface EnglishAudioTask {
  uid: string;
  episodeId: string;
  keys: string[];
}

const phraseRef = (uid: string, key: string) => db.doc(`users/${uid}/phrases/${key}`);
const episodeRef = (uid: string, episodeId: string) => db.doc(`users/${uid}/episodes/${episodeId}`);

async function getAll(refs: DocumentReference[]) {
  const out = [];
  for (let i = 0; i < refs.length; i += 300) out.push(...(await db.getAll(...refs.slice(i, i + 300))));
  return out;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Enqueues a task. The id makes an identical request a no-op while the first is still queued.
 * Cloud Tasks also refuses a name for about an hour after its task is deleted, so explicit
 * retries pass a nonce to get fresh ids.
 */
async function enqueue(fn: "studyChunk" | "englishAudio", data: StudyChunkTask | EnglishAudioTask, idSource: string) {
  const id = `${fn}-${createHash("sha256").update(idSource).digest("hex").slice(0, 40)}`;
  const queue = getFunctions().taskQueue(`locations/${REGION}/functions/${fn}`);
  try {
    await queue.enqueue(data, { id, dispatchDeadlineSeconds: 1800 });
  } catch (err) {
    if ((err as { code?: string }).code === "functions/task-already-exists") return;
    throw err;
  }
}

async function enqueueAudio(uid: string, episodeId: string, keys: string[], nonce = "") {
  for (const keys20 of chunk(keys, AUDIO_BATCH)) {
    await enqueue("englishAudio", { uid, episodeId, keys: keys20 }, `${uid}/${keys20.join(",")}${nonce}`);
  }
}

function isDone(data: FirebaseFirestore.DocumentData | undefined, level: CefrLevel): boolean {
  return !!data && data.level === level && typeof data.translation === "string";
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

async function recordError(uid: string, episodeId: string, field: "error" | "audioError", err: unknown) {
  await episodeRef(uid, episodeId)
    .update({ [`study.${field}`]: String(err instanceof Error ? err.message : err).slice(0, 500) })
    .catch(() => undefined);
}

/**
 * Turns study mode on for an episode (optionally with English audio) and queues whatever is
 * missing. Safe to call repeatedly, e.g. after phrases are split or merged.
 */
export const prepareStudy = onCall({ region: REGION, timeoutSeconds: 120 }, async (req) => {
  const uid = assertAllowed(req);
  const data = (req.data ?? {}) as { episodeId?: unknown; language?: unknown; english?: unknown; retry?: unknown };
  const episodeId = typeof data.episodeId === "string" ? data.episodeId : "";
  const language = typeof data.language === "string" ? data.language : "";
  if (!/^[A-Za-z0-9]{1,64}$/.test(episodeId)) throw new HttpsError("invalid-argument", "episodeId is required.");
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language)) {
    throw new HttpsError("invalid-argument", "A specific language is required (not auto-detect).");
  }

  const epSnap = await episodeRef(uid, episodeId).get();
  if (!epSnap.exists) throw new HttpsError("not-found", "Episode not found.");
  const segSnap = await db.doc(`users/${uid}/episodes/${episodeId}/data/segments`).get();
  const segments = (segSnap.get("segments") ?? []) as { text: string }[];
  if (segments.length === 0) throw new HttpsError("failed-precondition", "This episode has no phrases yet.");

  const prefs = await db.doc(`users/${uid}/prefs/study`).get();
  const level = prefs.get("levels")?.[language] as CefrLevel | undefined;
  if (!level || !CEFR_LEVELS.includes(level)) {
    throw new HttpsError("failed-precondition", "Set your level for this language first.");
  }

  const english = typeof data.english === "boolean" ? data.english : epSnap.get("study.english") === true;
  const nonce = data.retry === true ? `/${Date.now()}` : "";

  const seen = new Set<string>();
  const items: PhraseItem[] = [];
  for (const s of segments) {
    const text = normalizePhrase(s.text);
    if (!text) continue;
    const key = phraseKey(language, text);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, text });
  }

  const snaps = await getAll(items.map((it) => phraseRef(uid, it.key)));
  const missing: PhraseItem[] = [];
  const link: string[] = [];
  const needAudio: string[] = [];
  items.forEach((it, i) => {
    const d = snaps[i].data();
    if (!isDone(d, level)) {
      missing.push(it);
      return;
    }
    if (!(d!.episodeIds as string[] | undefined)?.includes(episodeId)) link.push(it.key);
    if (d!.enAudioText !== d!.translation) needAudio.push(it.key);
  });

  for (const keys of chunk(link, 400)) {
    const batch = db.batch();
    for (const key of keys) batch.update(phraseRef(uid, key), { episodeIds: FieldValue.arrayUnion(episodeId) });
    await batch.commit();
  }

  await episodeRef(uid, episodeId).update({
    "study.enabled": true,
    "study.english": english,
    "study.language": language,
    "study.level": level,
    "study.error": null,
    "study.audioError": null,
    "study.requestedAt": FieldValue.serverTimestamp(),
  });

  for (const items25 of chunk(missing, STUDY_BATCH)) {
    await enqueue(
      "studyChunk",
      { uid, episodeId, language, level, items: items25 },
      `${uid}/${episodeId}/${level}/${items25.map((it) => it.key).join(",")}${nonce}`,
    );
  }
  if (english) await enqueueAudio(uid, episodeId, needAudio, nonce);

  logger.info("Study queued", { uid, episodeId, total: items.length, missing: missing.length, audio: english ? needAudio.length : 0 });
  return { total: items.length, missing: missing.length, audio: english ? needAudio.length : 0 };
});

/** One Claude batch: translations and notes for up to STUDY_BATCH phrases. */
export const studyChunk = onTaskDispatched<StudyChunkTask>(
  {
    region: REGION,
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 60 },
    rateLimits: { maxConcurrentDispatches: 3 },
    timeoutSeconds: 1200,
    memory: "512MiB",
    secrets: [anthropicApiKey],
  },
  async (req) => {
    const { uid, episodeId, language, level, items } = req.data;
    try {
      const snaps = await getAll(items.map((it) => phraseRef(uid, it.key)));
      const todo = items.filter((_, i) => !isDone(snaps[i].data(), level));
      const already = items.filter((_, i) => isDone(snaps[i].data(), level));

      const batch = db.batch();
      for (const it of already) batch.update(phraseRef(uid, it.key), { episodeIds: FieldValue.arrayUnion(episodeId) });

      if (todo.length > 0) {
        const segSnap = await db.doc(`users/${uid}/episodes/${episodeId}/data/segments`).get();
        const segments = (segSnap.get("segments") ?? []) as { text: string }[];
        const transcript = segments.map((s) => normalizePhrase(s.text)).join("\n");
        const model = claudeModelId.value();
        const started = Date.now();
        const results = await studyPhrases({
          apiKey: anthropicApiKey.value(),
          model,
          languageName: languageName(language),
          level,
          transcript,
          phrases: todo.map((it) => it.text),
        });
        logger.info("Study batch done", { uid, episodeId, phrases: todo.length, ms: Date.now() - started });
        todo.forEach((it, i) => {
          batch.set(
            phraseRef(uid, it.key),
            {
              lang: language,
              text: it.text,
              level,
              ...results[i],
              model,
              episodeIds: FieldValue.arrayUnion(episodeId),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        });
      }
      await batch.commit();

      const ep = await episodeRef(uid, episodeId).get();
      if (ep.get("study.english") === true) await enqueueAudio(uid, episodeId, items.map((it) => it.key));
    } catch (err) {
      logger.error("Study batch failed", { uid, episodeId, err: String(err) });
      await recordError(uid, episodeId, "error", err);
      throw err; // let Cloud Tasks retry
    }
  },
);

/** Voices English translations. Skips phrases whose audio already matches their translation. */
export const englishAudio = onTaskDispatched<EnglishAudioTask>(
  {
    region: REGION,
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 30 },
    rateLimits: { maxConcurrentDispatches: 2 },
    timeoutSeconds: 900,
    memory: "512MiB",
    secrets: [elevenLabsApiKey],
  },
  async (req) => {
    const { uid, episodeId, keys } = req.data;
    try {
      for (const key of keys) {
        const ref = phraseRef(uid, key);
        const d = (await ref.get()).data();
        const translation = d?.translation as string | undefined;
        if (!translation || d?.enAudioText === translation) continue;

        const audio = await synthesizeSpeech({
          apiKey: elevenLabsApiKey.value(),
          voiceId: englishVoiceId.value(),
          modelId: ttsModelId.value(),
          text: translation,
          languageCode: "en",
        });
        const path = `users/${uid}/phrases/${key}/en.mp3`;
        const token = randomUUID();
        await bucket.file(path).save(audio, {
          contentType: "audio/mpeg",
          resumable: false,
          metadata: { metadata: { firebaseStorageDownloadTokens: token } },
        });
        const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
        await ref.update({ enAudioPath: path, enAudioUrl: url, enAudioText: translation });
      }
    } catch (err) {
      logger.error("English audio failed", { uid, episodeId, err: String(err) });
      await recordError(uid, episodeId, "audioError", err);
      throw err;
    }
  },
);

/** Earlier questions and answers sent back to Claude with a new question. */
const THREAD_LIMIT = 20;
/** Transcript lines either side of the phrase given as context. */
const CONTEXT_LINES = 4;

/**
 * Follow-up on one phrase: more detail on a note, a different explanation, or a free question.
 * The exchange is appended to the phrase doc's `thread` so it's there next time.
 */
export const explainPhrase = onCall(
  { region: REGION, timeoutSeconds: 180, secrets: [anthropicApiKey] },
  async (req) => {
    const uid = assertAllowed(req);
    const data = (req.data ?? {}) as { key?: unknown; episodeId?: unknown; mode?: unknown; note?: unknown; question?: unknown };
    const key = typeof data.key === "string" && /^[0-9a-f]{32}$/.test(data.key) ? data.key : "";
    const episodeId = typeof data.episodeId === "string" ? data.episodeId : "";
    const mode = data.mode;
    if (!key || !/^[A-Za-z0-9]{1,64}$/.test(episodeId)) throw new HttpsError("invalid-argument", "key and episodeId are required.");
    if (mode !== "detail" && mode !== "different" && mode !== "question") throw new HttpsError("invalid-argument", "Unknown mode.");

    const snap = await phraseRef(uid, key).get();
    if (!snap.exists) throw new HttpsError("not-found", "No study material for this phrase yet.");
    const p = snap.data()!;
    const notes = (p.notes ?? []) as StudyNote[];
    const note = typeof data.note === "number" ? notes[data.note] : undefined;

    let label: string;
    let request: string;
    if (mode === "question") {
      const q = typeof data.question === "string" ? data.question.trim().slice(0, 1000) : "";
      if (!q) throw new HttpsError("invalid-argument", "Question is empty.");
      label = q;
      request = q;
    } else if (note) {
      const about = `"${note.span}" (${note.title})`;
      label = mode === "detail" ? `More detail: ${note.span}` : `Explain differently: ${note.span}`;
      request =
        mode === "detail"
          ? `Please explain ${about} in more depth: how it works, when it's used, and a couple more examples.`
          : `I didn't quite get the explanation of ${about}. Could you explain it another way, from a different angle or with different examples?`;
    } else {
      label = mode === "detail" ? "Explain this phrase" : "Explain it differently";
      request =
        mode === "detail"
          ? "Please walk me through this phrase: how it's put together and anything in it I might find tricky."
          : "Could you explain this phrase another way?";
    }

    const segSnap = await db.doc(`users/${uid}/episodes/${episodeId}/data/segments`).get();
    const lines = ((segSnap.get("segments") ?? []) as { text: string }[]).map((s) => normalizePhrase(s.text));
    const at = lines.indexOf(p.text as string);
    const context = at < 0 ? p.text : lines.slice(Math.max(0, at - CONTEXT_LINES), at + CONTEXT_LINES + 1).join("\n");

    const history = ((p.thread ?? []) as ThreadEntry[]).slice(-THREAD_LIMIT);
    let answer: string;
    try {
      answer = await explain({
        apiKey: anthropicApiKey.value(),
        model: claudeModelId.value(),
        languageName: languageName(p.lang as string),
        level: p.level as CefrLevel,
        phrase: p.text as string,
        translation: p.translation as string,
        context,
        notes,
        history: history.map((t) => ({ role: t.role, text: t.role === "user" ? (t as ThreadEntry & { request?: string }).request ?? t.text : t.text })),
        request,
      });
    } catch (err) {
      logger.error("Explain failed", { uid, key, err: String(err) });
      throw new HttpsError("internal", err instanceof Error ? err.message : String(err));
    }

    const now = Date.now();
    const entries = [
      { role: "user", text: label, request, at: now },
      { role: "assistant", text: answer, at: now + 1 },
    ];
    await phraseRef(uid, key).update({ thread: FieldValue.arrayUnion(...entries) });
    return { answer };
  },
);
