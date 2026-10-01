/**
 * Plans one language's drill session within its time budget: due reviews first (the most overdue
 * first, then put back into story order), then new material from the excerpt being learned. New
 * material only starts once every due review fits, and learning can stop partway through a
 * passage and pick up next session, so sessions don't end early.
 */
import type { Drill, DrillPassage } from "../../types";
import { bookNewPassage, forecastLoad, overfilledBy, type LoadDay, type SessionDay } from "./forecast";
import { phraseBefore, phrasesIn } from "./passages";
import {
  blockSeconds,
  learnGroupSeconds,
  openingSeconds,
  wrapUpSeconds,
  type Block,
  type LearnBlock,
  type ReviewBlock,
} from "./session";
import { isDue, isLearned, overdueRatio, reviewedPassage } from "./srs";
import type { DrillOptions, SessionPhrase } from "./steps";

export interface PlanDrill {
  drill: Drill;
  /** Every phrase of the drill's episode, in order, with English where it's known. */
  phrases: SessionPhrase[];
}

export interface PlanInput {
  now: number;
  budgetSec: number;
  newMaterial: boolean;
  opts: DrillOptions;
  drills: PlanDrill[];
  /**
   * The language's session days after this one (see sessionDays). Given these, a new passage only
   * starts if its reviews will fit in them over the coming week.
   */
  upcoming?: SessionDay[];
}

export interface SessionPlan {
  blocks: Block[];
  /** Estimated length. */
  seconds: number;
  /** Passages due for review, and how many of them were left for a later session. */
  due: number;
  deferred: number;
  /** Set when a new passage was held back: the session day its reviews wouldn't have fitted in. */
  heldBack?: LoadDay;
}

export const passagePhrases = (d: PlanDrill, i: number) =>
  phrasesIn(d.phrases, d.drill.passages[i].start, d.drill.passages[i].end);

/** Index of the first passage not yet learned, or -1 when the excerpt is fully learned. */
export function frontier(drill: Drill): number {
  return drill.passages.findIndex((p) => !isLearned(p));
}

/** The excerpt new material comes from: one already under way, otherwise the oldest unfinished one. */
export function learningDrill<T extends { drill: Drill }>(drills: T[]): T | undefined {
  const open = drills.filter((d) => frontier(d.drill) >= 0);
  return (
    open.find((d) => d.drill.learning && d.drill.learning.passage === frontier(d.drill)) ??
    [...open].sort((a, b) => a.drill.createdAt - b.drill.createdAt)[0]
  );
}

function base(d: PlanDrill, i: number) {
  return {
    drillId: d.drill.id,
    episodeId: d.drill.episodeId,
    title: d.drill.title ?? d.drill.episodeTitle,
    passageTitle: d.drill.passages[i].title,
    passage: i,
    passageCount: d.drill.passages.length,
    phrases: passagePhrases(d, i),
  };
}

function reviewBlock(d: PlanDrill, i: number, withLeadIn: boolean): ReviewBlock {
  const p = d.drill.passages[i];
  return { kind: "review", ...base(d, i), level: p.level ?? 0, leadIn: withLeadIn ? phraseBefore(d.phrases, p.start) : undefined };
}

export function planSession(input: PlanInput): SessionPlan {
  const { now, budgetSec, opts } = input;

  const due: { d: PlanDrill; i: number; risk: number }[] = [];
  for (const d of input.drills) {
    d.drill.passages.forEach((p, i) => {
      if (isDue(p, now) && passagePhrases(d, i).length > 0) due.push({ d, i, risk: overdueRatio(p, now) });
    });
  }
  due.sort((a, b) => b.risk - a.risk);

  let seconds = 0;
  const picked: typeof due = [];
  for (const item of due) {
    const sec = blockSeconds(reviewBlock(item.d, item.i, true), opts);
    if (picked.length > 0 && seconds + sec > budgetSec) continue;
    picked.push(item);
    seconds += sec;
  }

  // Story order: excerpts by their most urgent passage, passages in order within each. A passage
  // right after the one just reviewed needs no lead-in.
  const blocks: Block[] = [];
  const follows = (drillId: string, i: number) => {
    const prev = blocks[blocks.length - 1];
    return !!prev && prev.drillId === drillId && prev.passage === i - 1;
  };
  for (const d of new Set(picked.map((x) => x.d))) {
    for (const item of picked.filter((x) => x.d === d).sort((a, b) => a.i - b.i)) {
      blocks.push(reviewBlock(d, item.i, !follows(d.drill.id, item.i)));
    }
  }
  seconds = blocks.reduce((sum, b) => sum + blockSeconds(b, opts), 0);

  const learner = input.newMaterial && picked.length === due.length ? learningDrill(input.drills) : undefined;
  let heldBack: LoadDay | undefined;
  if (learner) {
    // The reviews booked once this session's are done, to check new passages against.
    const load = input.upcoming && forecastLoad(passagesAfter(input.drills, blocks, now), input.upcoming, now, opts);
    const learned = planLearning(learner, blocks, budgetSec - seconds, opts, now, load);
    seconds += learned.used;
    heldBack = learned.heldBack;
  }

  return { blocks, seconds, due: due.length, deferred: due.length - picked.length, ...(heldBack ? { heldBack } : {}) };
}

/** Every passage as it will be once the planned reviews have passed. */
function passagesAfter(drills: PlanDrill[], blocks: Block[], now: number): DrillPassage[] {
  return drills.flatMap((d) =>
    d.drill.passages.map((p, i) =>
      blocks.some((b) => b.kind === "review" && b.drillId === d.drill.id && b.passage === i) ? reviewedPassage(p, true, now) : p,
    ),
  );
}

/**
 * Adds learning blocks for `d` that fit in `budget` seconds; returns the time they take. With a
 * `load`, a passage is only started if its reviews will fit (see overfilledBy), and is then booked
 * into it; otherwise learning stops there and `heldBack` says where it wouldn't fit.
 */
function planLearning(
  d: PlanDrill,
  blocks: Block[],
  budget: number,
  opts: DrillOptions,
  now: number,
  load?: LoadDay[],
): { used: number; heldBack?: LoadDay } {
  let used = 0;
  let i = frontier(d.drill);
  let from = d.drill.learning?.passage === i ? d.drill.learning.phrases : 0;
  while (i >= 0 && i < d.drill.passages.length) {
    const b = base(d, i);
    const prev = blocks[blocks.length - 1];
    const joined = !!prev && prev.drillId === b.drillId && prev.passage === i - 1;
    const block: LearnBlock = {
      kind: "learn",
      ...b,
      from: Math.min(from, b.phrases.length),
      to: 0,
      wrapUp: false,
      leadIn: joined ? undefined : phraseBefore(d.phrases, d.drill.passages[i].start),
    };
    if (b.phrases.length === 0) break;
    let sec = openingSeconds(block, opts);
    let to = block.from;
    while (to < b.phrases.length) {
      const g = learnGroupSeconds(block, to, opts);
      if (used + sec + g > budget) break;
      sec += g;
      to++;
    }
    let wrapUp = false;
    if (to === b.phrases.length) {
      const w = wrapUpSeconds(block, opts);
      if (used + sec + w <= budget) {
        wrapUp = true;
        sec += w;
      }
    }
    if (to === block.from && !wrapUp) break;
    if (load && block.from === 0) {
      const audioSec = d.drill.passages[i].end - d.drill.passages[i].start;
      const full = overfilledBy(load, audioSec, now, opts);
      if (full) return { used, heldBack: full };
      bookNewPassage(load, audioSec, now, opts);
    }
    blocks.push({ ...block, to, wrapUp });
    used += sec;
    if (!wrapUp) break;
    i++;
    from = 0;
  }
  return { used };
}

/** Rough time to learn passages from scratch, before any English exists (it's guessed from the audio length). */
export function learningSeconds(passages: SessionPhrase[][], opts: DrillOptions): number {
  return passages.reduce((sum, phrases) => {
    if (phrases.length === 0) return sum;
    const guessed = phrases.map((p) => ({ ...p, english: p.english ?? "x".repeat(Math.round((p.end - p.start) * 12)) }));
    const block: LearnBlock = {
      kind: "learn",
      drillId: "",
      episodeId: "",
      title: "",
      passage: 0,
      passageCount: 1,
      phrases: guessed,
      from: 0,
      to: guessed.length,
      wrapUp: true,
    };
    return sum + blockSeconds(block, opts);
  }, 0);
}
