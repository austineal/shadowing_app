/**
 * Drill callables that use Claude: suggesting excerpts of an episode, and splitting a chosen
 * excerpt into titled passages. (A drill's translations come from study mode; see study.ts.)
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { db } from "./admin.js";
import { REGION, anthropicApiKey, claudeModelId } from "./config.js";
import { assertAllowed } from "./auth.js";
import { CEFR_LEVELS, type CefrLevel } from "./claude.js";
import { passageRanges, planPassages, suggestSections } from "./excerpts.js";
import { languageName, normalizePhrase } from "./study.js";

interface Segment {
  text: string;
  start: number;
  end: number;
}

const ID = /^[A-Za-z0-9]{1,64}$/;

async function loadSegments(uid: string, episodeId: string): Promise<Segment[]> {
  const snap = await db.doc(`users/${uid}/episodes/${episodeId}/data/segments`).get();
  return (snap.get("segments") ?? []) as Segment[];
}

async function learnerLevel(uid: string, language: string): Promise<CefrLevel> {
  const prefs = await db.doc(`users/${uid}/prefs/study`).get();
  const level = prefs.get("levels")?.[language] as CefrLevel | undefined;
  if (!level || !CEFR_LEVELS.includes(level)) throw new HttpsError("failed-precondition", "Set your level for this language first.");
  return level;
}

const failure = (err: unknown) => new HttpsError("internal", err instanceof Error ? err.message : String(err));

/**
 * Splits an episode into self-contained sections of about `minutes` each, rated for speaking
 * practice, and saves them at users/{uid}/episodes/{id}/data/excerpts, replacing earlier ones.
 * Sections are stored as time ranges so later phrase edits don't break them.
 */
export const suggestExcerpts = onCall(
  { region: REGION, timeoutSeconds: 540, memory: "512MiB", secrets: [anthropicApiKey] },
  async (req) => {
    const uid = assertAllowed(req);
    const data = (req.data ?? {}) as { episodeId?: unknown; language?: unknown; minutes?: unknown };
    const episodeId = typeof data.episodeId === "string" ? data.episodeId : "";
    const language = typeof data.language === "string" ? data.language : "";
    const minutes = typeof data.minutes === "number" ? Math.min(30, Math.max(2, Math.round(data.minutes))) : 8;
    if (!ID.test(episodeId)) throw new HttpsError("invalid-argument", "episodeId is required.");
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language)) {
      throw new HttpsError("invalid-argument", "A specific language is required (not auto-detect).");
    }

    const episode = await db.doc(`users/${uid}/episodes/${episodeId}`).get();
    if (!episode.exists) throw new HttpsError("not-found", "Episode not found.");
    const segments = await loadSegments(uid, episodeId);
    if (segments.length === 0) throw new HttpsError("failed-precondition", "This episode has no phrases yet.");
    const level = await learnerLevel(uid, language);

    let sections;
    try {
      sections = await suggestSections({
        apiKey: anthropicApiKey.value(),
        model: claudeModelId.value(),
        languageName: languageName(language),
        level,
        minutes,
        lines: segments.map((s) => ({ start: s.start, text: normalizePhrase(s.text) })),
        durationSec: segments[segments.length - 1].end,
      });
    } catch (err) {
      logger.error("Excerpt suggestions failed", { uid, episodeId, err: String(err) });
      throw failure(err);
    }

    const saved = sections.map((s) => ({
      start: segments[s.first].start,
      end: segments[s.last].end,
      title: s.title,
      summary: s.summary,
      speaking: s.speaking,
      why: s.why,
      level: s.level,
    }));
    await db.doc(`users/${uid}/episodes/${episodeId}/data/excerpts`).set({
      language,
      level,
      minutes,
      model: claudeModelId.value(),
      sections: saved,
      createdAt: FieldValue.serverTimestamp(),
    });
    logger.info("Excerpts suggested", { uid, episodeId, minutes, sections: saved.length });
    return { sections: saved.length };
  },
);

/**
 * Splits a newly chosen drill excerpt into titled passages at natural break points and gives it a
 * title. The passages are replaced only while the drill has no progress, so a session already
 * under way keeps the passages it started with; the title is set either way.
 */
export const planDrillPassages = onCall({ region: REGION, timeoutSeconds: 180, secrets: [anthropicApiKey] }, async (req) => {
  const uid = assertAllowed(req);
  const data = (req.data ?? {}) as { drillId?: unknown };
  const drillId = typeof data.drillId === "string" ? data.drillId : "";
  if (!ID.test(drillId)) throw new HttpsError("invalid-argument", "drillId is required.");

  const ref = db.doc(`users/${uid}/drills/${drillId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Drill not found.");
  const drill = snap.data() as { episodeId: string; language: string; start: number; end: number };
  const lines = (await loadSegments(uid, drill.episodeId)).filter((s) => {
    const mid = (s.start + s.end) / 2;
    return mid >= drill.start && mid <= drill.end;
  });
  if (lines.length === 0) throw new HttpsError("failed-precondition", "No phrases fall inside this excerpt.");

  let planned;
  try {
    planned = await planPassages({
      apiKey: anthropicApiKey.value(),
      model: claudeModelId.value(),
      languageName: languageName(drill.language),
      lines: lines.map((l) => ({ duration: l.end - l.start, text: normalizePhrase(l.text) })),
    });
  } catch (err) {
    logger.error("Passage planning failed", { uid, drillId, err: String(err) });
    throw failure(err);
  }
  const ranges = passageRanges(lines, planned.passages);

  const applied = await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (!cur.exists) return false;
    const d = cur.data()!;
    const untouched = !d.learning && ((d.passages ?? []) as { level?: number }[]).every((p) => p.level === undefined);
    const patch: Record<string, unknown> = {};
    if (!d.title && planned.title) patch.title = planned.title;
    if (untouched && ranges) {
      patch.passages = ranges.map((r) => ({ start: r.start, end: r.end, ...(r.title ? { title: r.title } : {}) }));
    }
    if (Object.keys(patch).length > 0) tx.update(ref, patch);
    return "passages" in patch;
  });
  logger.info("Drill passages planned", { uid, drillId, passages: ranges?.length ?? 0, applied });
  return { title: planned.title, passages: ranges?.length ?? 0, applied };
});
