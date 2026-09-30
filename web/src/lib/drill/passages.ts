import { SENTENCE_END } from "../segmenter";

interface Timed {
  start: number;
  end: number;
}

export interface PassageOptions {
  /** Preferred passage length. */
  targetSec: number;
  /** Shorter passages are penalised more steeply. */
  minSec: number;
  /** Passages of several phrases never run longer than this; a single long phrase may. */
  maxSec: number;
}

/** Long enough to be worth reviewing on its own, short enough to learn in one sitting. */
export const PASSAGE_OPTIONS: PassageOptions = { targetSec: 40, minSec: 25, maxSec: 60 };

const mid = (p: Timed) => (p.start + p.end) / 2;

/** The phrases whose midpoint lies in [start, end). */
export function phrasesIn<T extends Timed>(phrases: T[], start: number, end: number): T[] {
  return phrases.filter((p) => mid(p) >= start && mid(p) < end);
}

/** Indices of the first and last phrases whose midpoints lie within [start, end], or null if none do. */
export function phraseSpan(phrases: Timed[], start: number, end: number): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  phrases.forEach((p, i) => {
    if (mid(p) >= start && mid(p) <= end) {
      if (first < 0) first = i;
      last = i;
    }
  });
  return first < 0 ? null : { first, last };
}

/** The phrase just before `time` (the last one whose midpoint is earlier), if any. */
export function phraseBefore<T extends Timed>(phrases: T[], time: number): T | undefined {
  let found: T | undefined;
  for (const p of phrases) {
    if (mid(p) < time) found = p;
    else break;
  }
  return found;
}

/**
 * Cuts an excerpt's phrases (in order) into passages of about `targetSec`, preferring to break at
 * long pauses and sentence ends. Passages tile the excerpt: each ends halfway through the pause
 * before the next, so every phrase falls into exactly one of them.
 */
export function splitPassages(phrases: (Timed & { text: string })[], opts: PassageOptions = PASSAGE_OPTIONS): Timed[] {
  const n = phrases.length;
  if (n === 0) return [];

  const lengthCost = (sec: number) => {
    let c = ((sec - opts.targetSec) / opts.targetSec) ** 2 * 4;
    if (sec < opts.minSec) c += ((opts.minSec - sec) / opts.minSec) ** 2 * 4;
    return c;
  };
  // Reward for ending a passage after phrase i: a pause, especially after a full sentence.
  const breakBonus = (i: number) => {
    const pause = Math.max(0, phrases[i + 1].start - phrases[i].end);
    return Math.min(pause, 1.5) * 0.4 + (SENTENCE_END.test(phrases[i].text) ? 0.2 : 0);
  };

  // best[j]: lowest cost of cutting phrases[0..j) into passages; from[j]: where the last one starts.
  const best = new Array<number>(n + 1).fill(Infinity);
  const from = new Array<number>(n + 1).fill(0);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const sec = phrases[j - 1].end - phrases[i].start;
      if (sec > opts.maxSec && j - i > 1) break;
      const cost = best[i] + lengthCost(sec) - (j < n ? breakBonus(j - 1) : 0);
      if (cost < best[j]) {
        best[j] = cost;
        from[j] = i;
      }
    }
  }

  const cuts: number[] = [];
  for (let j = n; j > 0; j = from[j]) cuts.unshift(from[j]);
  return cuts.map((i, k) => {
    const last = (cuts[k + 1] ?? n) - 1;
    const start = i === 0 ? phrases[0].start : (phrases[i - 1].end + phrases[i].start) / 2;
    const end = last === n - 1 ? phrases[n - 1].end : (phrases[last].end + phrases[last + 1].start) / 2;
    return { start, end };
  });
}
