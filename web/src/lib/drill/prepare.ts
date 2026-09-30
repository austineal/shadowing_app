/**
 * Loading and planning a language's next drill session: its excerpts, their episodes' phrases and
 * English, the plan for the time available, and the English the plan needs spoken. Used by the
 * session page and by the background preparation of English clips.
 */
import { ensureAudioUrl, getEpisodeOnce, getSegmentsOnce } from "../episodes";
import { loadDefaultSettings } from "../settings";
import { normalizePhrase } from "../study";
import { DEFAULT_ENGLISH_VOICE } from "../tts/client";
import type { Drill, DrillPrefs, DrillSchedule } from "../../types";
import { DEFAULT_SCHEDULE } from "./labels";
import { phrasesIn } from "./passages";
import { frontier, planSession, type PlanDrill, type SessionPlan } from "./plan";
import type { Block } from "./session";
import { isDue } from "./srs";
import { drillOptions, type DrillOptions, type SessionPhrase } from "./steps";
import { getDrillPrefs, getDrills, loadTranslations } from "./store";

export interface Prepared {
  schedule: DrillSchedule;
  opts: DrillOptions;
  plan: SessionPlan;
  drills: Drill[];
  /** The voice that reads the English. */
  voice: string;
  /** Audio URL of each episode the plan plays from (empty when not asked for). */
  sources: Record<string, string>;
  /** English the plan needs spoken. */
  english: string[];
  /** Phrases in the plan with no translation yet; they can only be heard and repeated. */
  untranslated: number;
  /** The earliest upcoming review, to mention when there's nothing to do now. */
  nextDue?: number;
}

/** The voice for drills: the one chosen for them, else the practice player's default. */
export function drillVoice(prefs: DrillPrefs | undefined): string {
  return prefs?.voice ?? loadDefaultSettings().englishVoice ?? DEFAULT_ENGLISH_VOICE;
}

/** The phrases a block drills: a learning block may cover only part of its passage. */
function blockPhrases(b: Block): SessionPhrase[] {
  if (b.kind === "review" || b.wrapUp) return b.phrases;
  return b.phrases.slice(Math.max(0, b.from - 1), b.to);
}

/** Plans the language's session as it would run at `now`. `withAudio` also resolves the episodes' audio URLs. */
export async function prepareSession(uid: string, language: string, now: number, withAudio = true): Promise<Prepared> {
  const [prefs, drills] = await Promise.all([getDrillPrefs(uid), getDrills(uid, language)]);
  const schedule = prefs.schedules[language] ?? DEFAULT_SCHEDULE;
  const opts = drillOptions(schedule.learning, loadDefaultSettings());
  const loaded = (
    await Promise.all(
      drills.map(async (drill) => {
        const [episode, segDoc] = await Promise.all([getEpisodeOnce(uid, drill.episodeId), getSegmentsOnce(uid, drill.episodeId)]);
        return episode && segDoc ? { drill, episode, segments: segDoc.segments } : undefined;
      }),
    )
  ).filter((x) => x !== undefined);

  // English for the passages this session could use: every due one and the next few to learn.
  const texts: string[] = [];
  for (const { drill, segments } of loaded) {
    const f = frontier(drill);
    drill.passages.forEach((p, i) => {
      if (isDue(p, now) || (f >= 0 && i >= f && i < f + 3)) texts.push(...phrasesIn(segments, p.start, p.end).map((s) => s.text));
    });
  }
  const english = await loadTranslations(uid, language, texts);
  const planDrills: PlanDrill[] = loaded.map(({ drill, segments }) => ({
    drill,
    phrases: segments.map((s) => ({ start: s.start, end: s.end, text: s.text, english: english.get(normalizePhrase(s.text)) })),
  }));
  const plan = planSession({ now, budgetSec: schedule.minutes * 60, newMaterial: schedule.newMaterial, opts, drills: planDrills });

  const sources: Record<string, string> = {};
  if (withAudio) {
    for (const { episode } of loaded) {
      if (plan.blocks.some((b) => b.episodeId === episode.id)) sources[episode.id] = await ensureAudioUrl(uid, episode);
    }
  }
  const needed = new Set<string>();
  let untranslated = 0;
  for (const b of plan.blocks) {
    for (const p of blockPhrases(b)) {
      if (p.english) needed.add(p.english);
      else untranslated++;
    }
  }
  const upcoming = loaded.flatMap(({ drill }) => drill.passages.flatMap((p) => (p.level !== undefined && p.due ? [p.due] : [])));
  return {
    schedule,
    opts,
    plan,
    drills: loaded.map((l) => l.drill),
    voice: drillVoice(prefs),
    sources,
    english: [...needed],
    untranslated,
    nextDue: upcoming.length ? Math.min(...upcoming) : undefined,
  };
}
