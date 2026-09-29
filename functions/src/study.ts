/**
 * Study mode: translations and study notes for an episode's phrases. (English audio is generated
 * on the user's device; see web/src/lib/tts.)
 *
 * Results are stored per phrase text, not per segment, at users/{uid}/phrases/{key} where key
 * hashes the language and normalised text. Segment ids change whenever phrases are split, merged
 * or rebuilt; keying by text means only genuinely new phrases need generating, and a line that
 * recurs across episodes is only done once. Each phrase doc lists the episodes that use it so the
 * client can subscribe to one episode's material with a single query.
 *
 * prepareStudy (callable) works out what is missing and queues the work, and prepareDrillStudy does
 * the same for one excerpt (for drills). studyChunk runs one Claude batch as a task-queue function,
 * so long episodes don't hit request timeouts and failed batches retry on their own.
 */
import { createHash } from "node:crypto";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { getFunctions } from "firebase-admin/functions";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { db } from "./admin.js";
import {
  REGION,
  anthropicApiKey,
  claudeModelId,
} from "./config.js";
import { assertAllowed } from "./auth.js";
import { CEFR_LEVELS, explain, studyPhrases, type CefrLevel, type StudyNote, type ThreadEntry } from "./claude.js";

/** Phrases per Claude request. */
const STUDY_BATCH = 25;

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
async function enqueue(fn: "studyChunk", data: StudyChunkTask, idSource: string) {
  const id = `${fn}-${createHash("sha256").update(idSource).digest("hex").slice(0, 40)}`;
  const queue = getFunctions().taskQueue(`locations/${REGION}/functions/${fn}`);
  try {
    await queue.enqueue(data, { id, dispatchDeadlineSeconds: 1800 });
  } catch (err) {
    if ((err as { code?: string }).code === "functions/task-already-exists") return;
    throw err;
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

async function recordError(uid: string, episodeId: string, err: unknown) {
  await episodeRef(uid, episodeId)
    .update({ "study.error": String(err instanceof Error ? err.message : err).slice(0, 500) })
    .catch(() => undefined);
}

interface StudyRequest {
  uid: string;
  episodeId: string;
  language: string;
  level: CefrLevel;
  segments: { text: string; start: number; end: number }[];
  /** Appended to task ids so an explicit retry isn't refused as a duplicate. */
  nonce: string;
}

/** Checks a study request and loads the episode's phrases and the learner's level. */
async function loadStudyRequest(req: CallableRequest<unknown>): Promise<StudyRequest> {
  const uid = assertAllowed(req);
  const data = (req.data ?? {}) as { episodeId?: unknown; language?: unknown; retry?: unknown };
  const episodeId = typeof data.episodeId === "string" ? data.episodeId : "";
  const language = typeof data.language === "string" ? data.language : "";
  if (!/^[A-Za-z0-9]{1,64}$/.test(episodeId)) throw new HttpsError("invalid-argument", "episodeId is required.");
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language)) {
    throw new HttpsError("invalid-argument", "A specific language is required (not auto-detect).");
  }

  const epSnap = await episodeRef(uid, episodeId).get();
  if (!epSnap.exists) throw new HttpsError("not-found", "Episode not found.");
  const segSnap = await db.doc(`users/${uid}/episodes/${episodeId}/data/segments`).get();
  const segments = (segSnap.get("segments") ?? []) as StudyRequest["segments"];
  if (segments.length === 0) throw new HttpsError("failed-precondition", "This episode has no phrases yet.");

  const prefs = await db.doc(`users/${uid}/prefs/study`).get();
  const level = prefs.get("levels")?.[language] as CefrLevel | undefined;
  if (!level || !CEFR_LEVELS.includes(level)) {
    throw new HttpsError("failed-precondition", "Set your level for this language first.");
  }

  return { uid, episodeId, language, level, segments, nonce: data.retry === true ? `/${Date.now()}` : "" };
}

/**
 * Sorts phrases into those already done at the learner's level, which are linked to the episode
 * here, and those still missing. Returns all distinct phrases and the missing ones.
 */
async function linkDone(r: StudyRequest, segments: { text: string }[]): Promise<{ items: PhraseItem[]; missing: PhraseItem[] }> {
  const seen = new Set<string>();
  const items: PhraseItem[] = [];
  for (const s of segments) {
    const text = normalizePhrase(s.text);
    if (!text) continue;
    const key = phraseKey(r.language, text);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, text });
  }

  const snaps = await getAll(items.map((it) => phraseRef(r.uid, it.key)));
  const missing: PhraseItem[] = [];
  const link: string[] = [];
  items.forEach((it, i) => {
    const d = snaps[i].data();
    if (!isDone(d, r.level)) {
      missing.push(it);
      return;
    }
    if (!(d!.episodeIds as string[] | undefined)?.includes(r.episodeId)) link.push(it.key);
  });

  for (const keys of chunk(link, 400)) {
    const batch = db.batch();
    for (const key of keys) batch.update(phraseRef(r.uid, key), { episodeIds: FieldValue.arrayUnion(r.episodeId) });
    await batch.commit();
  }
  return { items, missing };
}

/** Queues Claude batches for missing phrases. */
async function queueMissing(r: StudyRequest, missing: PhraseItem[]) {
  const { uid, episodeId, language, level } = r;
  for (const items25 of chunk(missing, STUDY_BATCH)) {
    await enqueue(
      "studyChunk",
      { uid, episodeId, language, level, items: items25 },
      `${uid}/${episodeId}/${level}/${items25.map((it) => it.key).join(",")}${r.nonce}`,
    );
  }
}

/**
 * Turns study mode on for an episode and queues whatever is
 * missing. Safe to call repeatedly, e.g. after phrases are split or merged.
 */
export const prepareStudy = onCall({ region: REGION, timeoutSeconds: 120 }, async (req) => {
  const r = await loadStudyRequest(req);
  const { items, missing } = await linkDone(r, r.segments);

  await episodeRef(r.uid, r.episodeId).update({
    "study.enabled": true,
    "study.language": r.language,
    "study.level": r.level,
    "study.error": null,
    "study.requestedAt": FieldValue.serverTimestamp(),
  });

  await queueMissing(r, missing);
  logger.info("Study queued", { uid: r.uid, episodeId: r.episodeId, total: items.length, missing: missing.length });
  return { total: items.length, missing: missing.length };
});

/**
 * Queues study material for the phrases of one excerpt, which a drill needs for its English cues.
 * Unlike prepareStudy it leaves study mode off for the episode, so drilling ten minutes of a long
 * episode doesn't translate the whole of it. The transcript Claude reads for context is still the
 * whole episode. Takes the excerpt as start and end times in seconds; a phrase belongs to it when
 * its midpoint falls inside.
 */
export const prepareDrillStudy = onCall({ region: REGION, timeoutSeconds: 120 }, async (req) => {
  const r = await loadStudyRequest(req);
  const data = (req.data ?? {}) as { start?: unknown; end?: unknown };
  const start = typeof data.start === "number" ? data.start : NaN;
  const end = typeof data.end === "number" ? data.end : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new HttpsError("invalid-argument", "The excerpt's start and end times are required.");
  }
  const inside = r.segments.filter((s) => {
    const mid = (s.start + s.end) / 2;
    return mid >= start && mid <= end;
  });
  if (inside.length === 0) throw new HttpsError("failed-precondition", "No phrases fall inside that excerpt.");

  const { items, missing } = await linkDone(r, inside);
  await queueMissing(r, missing);
  logger.info("Drill study queued", { uid: r.uid, episodeId: r.episodeId, start, end, total: items.length, missing: missing.length });
  return { total: items.length, missing: missing.length };
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

    } catch (err) {
      logger.error("Study batch failed", { uid, episodeId, err: String(err) });
      await recordError(uid, episodeId, err);
      throw err; // let Cloud Tasks retry
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
