/**
 * Where an excerpt's passages stand, for the progress map: the strips in the drill lists and the
 * colours in an episode's transcript.
 */
import type { Drill } from "../../types";
import { frontier } from "./plan";
import { isDue, isLearned } from "./srs";

/** A passage's stage: not started, partly learned, then by level once learned. */
export type PassageStage = "new" | "learning" | "fresh" | "growing" | "solid";

/** From this level a passage counts as solid: it was still there after a week away. */
export const SOLID_LEVEL = 4;

export function passageStage(drill: Drill, i: number): PassageStage {
  const level = drill.passages[i].level;
  if (level === undefined) return drill.learning?.passage === i && drill.learning.phrases > 0 ? "learning" : "new";
  return level >= SOLID_LEVEL ? "solid" : level >= 2 ? "growing" : "fresh";
}

export const STAGE_LABEL: Record<PassageStage, string> = {
  new: "not learned yet",
  learning: "being learned",
  fresh: "just learned",
  growing: "growing",
  solid: "solid",
};

export interface Progress {
  passages: number;
  learned: number;
  solid: number;
  due: number;
}

export function progressOf(drills: Drill[], now: number): Progress {
  const all = drills.flatMap((d) => d.passages);
  return {
    passages: all.length,
    learned: all.filter(isLearned).length,
    solid: all.filter((p) => (p.level ?? -1) >= SOLID_LEVEL).length,
    due: all.filter((p) => isDue(p, now)).length,
  };
}

/** "5 of 12 learned · 2 solid · 1 due" */
export function formatProgress(p: Progress): string {
  return [`${p.learned} of ${p.passages} learned`, p.solid ? `${p.solid} solid` : "", p.due ? `${p.due} due` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** A phrase of an episode that lies in a drilled excerpt. */
export interface PhraseMark {
  drill: Drill;
  passage: number;
  stage: PassageStage;
  due: boolean;
  /** The passage starts with this phrase. */
  first: boolean;
  /** The excerpt is learned up to the end of this phrase (and not all of it is). */
  learnedTo: boolean;
}

/**
 * Marks for the phrases of an episode (by index) that lie in the given excerpts of it. A phrase
 * belongs to the passage containing its midpoint, as in the drills themselves.
 */
export function transcriptMarks(phrases: { start: number; end: number }[], drills: Drill[], now: number): Map<number, PhraseMark> {
  const marks = new Map<number, PhraseMark>();
  for (const drill of drills) {
    const members: number[][] = drill.passages.map(() => []);
    phrases.forEach((s, j) => {
      const mid = (s.start + s.end) / 2;
      const i = drill.passages.findIndex((p) => mid >= p.start && mid < p.end);
      if (i >= 0) members[i].push(j);
    });
    members.forEach((idx, i) => {
      const stage = passageStage(drill, i);
      const due = isDue(drill.passages[i], now);
      idx.forEach((j, k) => marks.set(j, { drill, passage: i, stage, due, first: k === 0, learnedTo: false }));
    });
    // Learned up to here: partway through the passage being learned, else the end of the last learned one.
    const f = frontier(drill);
    if (f < 0) continue;
    const partway = drill.learning?.passage === f ? Math.min(drill.learning.phrases, members[f].length) : 0;
    const last = partway > 0 ? members[f][partway - 1] : f > 0 ? members[f - 1][members[f - 1].length - 1] : undefined;
    const mark = last === undefined ? undefined : marks.get(last);
    if (mark) mark.learnedTo = true;
  }
  return marks;
}
