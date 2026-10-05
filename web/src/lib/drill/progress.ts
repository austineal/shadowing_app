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

/** A cell of the progress map: one passage, or a run of them when there are too many to show singly. */
export interface MapCell {
  /** The first passage in the cell, and one past the last. */
  from: number;
  to: number;
  /** The most common stage in the cell (the less advanced on a tie). */
  stage: PassageStage;
  /** How many passages in the cell are at each stage. */
  stages: Partial<Record<PassageStage, number>>;
  due: number;
  /** Total audio length, for sizing the cell in a strip. */
  seconds: number;
}

const STAGES: PassageStage[] = ["new", "learning", "fresh", "growing", "solid"];

/** The map's cells: one per passage, or runs of equal size so there are at most `max` cells. */
export function mapCells(drill: Drill, now: number, max: number): MapCell[] {
  const n = drill.passages.length;
  const size = Math.max(1, Math.ceil(n / max));
  const cells: MapCell[] = [];
  for (let from = 0; from < n; from += size) {
    const to = Math.min(n, from + size);
    const stages: MapCell["stages"] = {};
    let due = 0;
    let seconds = 0;
    for (let i = from; i < to; i++) {
      const s = passageStage(drill, i);
      stages[s] = (stages[s] ?? 0) + 1;
      const p = drill.passages[i];
      if (isDue(p, now)) due++;
      seconds += p.end - p.start;
    }
    const stage = STAGES.reduce((a, s) => ((stages[s] ?? 0) > (stages[a] ?? 0) ? s : a));
    cells.push({ from, to, stage, stages, due, seconds });
  }
  return cells;
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
      // A deck's cards are coloured but not labelled: a label per card would be noise.
      idx.forEach((j, k) => marks.set(j, { drill, passage: i, stage, due, first: k === 0 && drill.kind !== "cards", learnedTo: false }));
    });
    if (drill.kind === "cards") continue;
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
