/**
 * Plans one language's drill session within its time budget: due reviews first (the most overdue
 * first, then put back into story order), then new material from the excerpt being learned. New
 * material only starts once every due review fits, and learning can stop partway through a
 * passage and pick up next session, so sessions don't end early.
 *
 * Decks are drilled card by card: due cards are reviewed in shuffled rounds, and new cards are
 * learned a few at a time. When a language has both an excerpt and a deck to learn from, the deck
 * gets up to half of the time left for new material.
 */
import type { Drill, DrillPassage } from "../../types";
import { CARD_ROUND, bookNewPassage, forecastLoad, overfilledBy, type LoadDay, type SessionDay } from "./forecast";
import { phraseBefore, phrasesIn } from "./passages";
import {
  blockSeconds,
  blockUnits,
  learnGroupSeconds,
  openingSeconds,
  unitsSeconds,
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

interface PlanInput {
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
  /** Shuffles cards; Math.random unless given (for tests). */
  random?: () => number;
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

const passagePhrases = (d: PlanDrill, i: number) =>
  phrasesIn(d.phrases, d.drill.passages[i].start, d.drill.passages[i].end);

/** New cards learned together, then tested together. */
export const CARD_BATCH = 5;
/** A deck's share of the time for new material when an excerpt is being learned too. */
const CARD_SHARE = 0.5;

const isCards = (d: PlanDrill) => d.drill.kind === "cards";

/** Index of the first passage not yet learned, or -1 when the excerpt is fully learned. */
export function frontier(drill: Drill): number {
  return drill.passages.findIndex((p) => !isLearned(p));
}

function shuffled<T>(xs: T[], random: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A deck's cards as one block: each card's phrase, in the order given, tested in a shuffled order. */
function cardsBase(d: PlanDrill, cards: number[], random: () => number) {
  return {
    drillId: d.drill.id,
    episodeId: d.drill.episodeId,
    title: d.drill.title ?? d.drill.episodeTitle,
    passage: cards[0],
    passageCount: d.drill.passages.length,
    phrases: cards.map((i) => passagePhrases(d, i)[0]),
    cards,
    order: shuffled(
      cards.map((_, k) => k),
      random,
    ),
  };
}

function cardReviewBlock(d: PlanDrill, cards: number[], random: () => number): ReviewBlock {
  // One answer time for the round: the least practised card's.
  const level = Math.min(...cards.map((i) => d.drill.passages[i].level ?? 0));
  return { kind: "review", ...cardsBase(d, cards, random), level };
}

function cardLearnBlock(d: PlanDrill, cards: number[], random: () => number): LearnBlock {
  return { kind: "learn", ...cardsBase(d, cards, random), from: 0, to: cards.length, wrapUp: true };
}

/** A card's share of a review round: its test, and its part of the round's announcement. */
function cardReviewSeconds(d: PlanDrill, i: number, opts: DrillOptions): number {
  const block = cardReviewBlock(d, [i], Math.random);
  const units = blockUnits(block, opts);
  return (
    unitsSeconds(block, units.filter((u) => u.kind !== "announce"), opts) +
    unitsSeconds(block, units.filter((u) => u.kind === "announce"), opts) / CARD_ROUND
  );
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
  const random = input.random ?? Math.random;

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
    const sec = isCards(item.d) ? cardReviewSeconds(item.d, item.i, opts) : blockSeconds(reviewBlock(item.d, item.i, true), opts);
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
  const decks = new Set<PlanDrill>();
  for (const d of new Set(picked.map((x) => x.d))) {
    if (isCards(d)) {
      decks.add(d);
      continue;
    }
    for (const item of picked.filter((x) => x.d === d).sort((a, b) => a.i - b.i)) {
      blocks.push(reviewBlock(d, item.i, !follows(d.drill.id, item.i)));
    }
  }
  // Due cards after the passages, shuffled, in rounds.
  for (const d of decks) {
    const cards = shuffled(
      picked.filter((x) => x.d === d).map((x) => x.i),
      random,
    );
    for (let k = 0; k < cards.length; k += CARD_ROUND) blocks.push(cardReviewBlock(d, cards.slice(k, k + CARD_ROUND), random));
  }
  seconds = blocks.reduce((sum, b) => sum + blockSeconds(b, opts), 0);

  const allDue = input.newMaterial && picked.length === due.length;
  const learner = allDue ? learningDrill(input.drills.filter((d) => !isCards(d))) : undefined;
  const deck = allDue ? learningDrill(input.drills.filter(isCards)) : undefined;
  let heldBack: LoadDay | undefined;
  if (learner || deck) {
    // The reviews booked once this session's are done, to check new passages against.
    const load = input.upcoming && forecastLoad(passagesAfter(input.drills, blocks, now), input.upcoming, now, opts);
    // The deck takes its share first, the excerpt what's left, then the deck any time still over.
    const cardBlocks: Block[] = [];
    let next: number | undefined;
    if (deck) {
      const share = (budgetSec - seconds) * (learner ? CARD_SHARE : 1);
      const learned = planCardLearning(deck, cardBlocks, share, opts, now, random, load);
      seconds += learned.used;
      heldBack = learned.heldBack;
      next = learned.next;
    }
    if (learner) {
      const learned = planLearning(learner, blocks, budgetSec - seconds, opts, now, load);
      seconds += learned.used;
      heldBack ??= learned.heldBack;
    }
    if (deck && learner && next !== undefined && !heldBack) {
      const learned = planCardLearning(deck, cardBlocks, budgetSec - seconds, opts, now, random, load, next);
      seconds += learned.used;
      heldBack = learned.heldBack;
    }
    blocks.push(...cardBlocks);
  }

  return { blocks, seconds, due: due.length, deferred: due.length - picked.length, ...(heldBack ? { heldBack } : {}) };
}

/** Every passage as it will be once the planned reviews have passed. */
function passagesAfter(drills: PlanDrill[], blocks: Block[], now: number): DrillPassage[] {
  return drills.flatMap((d) =>
    d.drill.passages.map((p, i) =>
      blocks.some((b) => b.kind === "review" && b.drillId === d.drill.id && (b.cards ? b.cards.includes(i) : b.passage === i))
        ? reviewedPassage(p, true, now)
        : p,
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

/**
 * Adds blocks of new cards from deck `d` that fit in `budget` seconds, CARD_BATCH at a time in
 * the deck's order, starting from its first card not learned (or `from`). Returns the time they
 * take and where to carry on, or with a `load`, `heldBack` once a card's reviews wouldn't fit.
 */
function planCardLearning(
  d: PlanDrill,
  blocks: Block[],
  budget: number,
  opts: DrillOptions,
  now: number,
  random: () => number,
  load?: LoadDay[],
  from?: number,
): { used: number; next?: number; heldBack?: LoadDay } {
  const ps = d.drill.passages;
  const learnable = (j: number) => j < ps.length && !isLearned(ps[j]) && passagePhrases(d, j).length > 0;
  let used = 0;
  let heldBack: LoadDay | undefined;
  let i = from ?? frontier(d.drill);
  while (i >= 0 && learnable(i)) {
    const batch: number[] = [];
    for (let j = i; batch.length < CARD_BATCH && learnable(j); j++) batch.push(j);
    let n = batch.length;
    while (n > 0 && used + blockSeconds(cardLearnBlock(d, batch.slice(0, n), random), opts) > budget) n--;
    if (n === 0) break;
    if (load) {
      let fits = 0;
      for (const j of batch.slice(0, n)) {
        const sec = ps[j].end - ps[j].start;
        const full = overfilledBy(load, sec, now, opts, true);
        if (full) {
          heldBack = full;
          break;
        }
        bookNewPassage(load, sec, now, opts, true);
        fits++;
      }
      n = fits;
      if (n === 0) break;
    }
    const block = cardLearnBlock(d, batch.slice(0, n), random);
    blocks.push(block);
    used += blockSeconds(block, opts);
    i += n;
    if (n < batch.length) break;
  }
  return { used, next: i, ...(heldBack ? { heldBack } : {}) };
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
