import type { Segment, TimedToken } from "../types";

export interface SegmentOptions {
  maxPhraseSec: number;
  minPhraseSec: number;
  /** A silence at least this long always ends a phrase. */
  hardGapSec?: number;
}

/** Sentence-final punctuation (Latin, CJK), optionally followed by closing quotes/brackets. */
const SENTENCE_END = /[.!?。！？…]+["'”’»)\]]*$/u;
/** Clause punctuation: good secondary split points. */
const CLAUSE_END = /[,;:、，；：—–]+["'”’»)\]]*$/u;

interface IndexedWord extends TimedToken {
  /** Index into the original token array. */
  i: number;
}

let idCounter = 0;
export function newSegmentId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/**
 * Turns timed tokens into practice phrases.
 * 1. Break at sentence-final punctuation and long silences.
 * 2. Recursively split anything longer than maxPhraseSec at the best clause
 *    boundary / pause near the middle.
 * 3. Merge phrases shorter than minPhraseSec into a neighbour when that fits.
 */
export function segmentTokens(tokens: TimedToken[], opts: SegmentOptions): Segment[] {
  const hardGap = opts.hardGapSec ?? 1.0;
  const words: IndexedWord[] = [];
  tokens.forEach((t, i) => {
    if (t.type === "word" && t.text.trim()) words.push({ ...t, i });
  });
  if (words.length === 0) return [];

  // Step 1: sentences.
  const sentences: number[][] = [];
  let cur: number[] = [];
  for (let k = 0; k < words.length; k++) {
    cur.push(k);
    const w = words[k];
    const next = words[k + 1];
    const endsHere = !next || SENTENCE_END.test(w.text) || next.start - w.end >= hardGap;
    if (endsHere) {
      sentences.push(cur);
      cur = [];
    }
  }

  // Step 2: split long.
  const ranges: number[][] = [];
  const duration = (r: number[]) => words[r[r.length - 1]].end - words[r[0]].start;

  const splitLong = (range: number[]) => {
    const dur = duration(range);
    if (dur <= opts.maxPhraseSec || range.length < 2) {
      ranges.push(range);
      return;
    }
    const rangeStart = words[range[0]].start;
    const rangeEnd = words[range[range.length - 1]].end;
    const mid = rangeStart + dur / 2;
    let best = -1;
    let bestScore = -Infinity;
    for (let j = 0; j < range.length - 1; j++) {
      const w = words[range[j]];
      const n = words[range[j + 1]];
      const left = w.end - rangeStart;
      const right = rangeEnd - n.start;
      if (left < opts.minPhraseSec || right < opts.minPhraseSec) continue;
      const gap = Math.max(0, n.start - w.end);
      let score = gap * 2;
      if (SENTENCE_END.test(w.text)) score += 1.5;
      else if (CLAUSE_END.test(w.text)) score += 1.0;
      // Prefer splits near the middle so both halves are useful.
      score -= Math.abs(w.end - mid) / dur;
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best < 0) best = Math.floor(range.length / 2) - 1;
    splitLong(range.slice(0, best + 1));
    splitLong(range.slice(best + 1));
  };
  for (const s of sentences) splitLong(s);

  // Step 3: merge short.
  const merged: number[][] = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && duration(prev) < opts.minPhraseSec && duration([...prev, ...r]) <= opts.maxPhraseSec) {
      merged[merged.length - 1] = [...prev, ...r];
    } else {
      merged.push(r);
    }
  }
  for (let k = 0; k < merged.length; k++) {
    const r = merged[k];
    const next = merged[k + 1];
    if (next && duration(r) < opts.minPhraseSec && duration([...r, ...next]) <= opts.maxPhraseSec) {
      merged.splice(k, 2, [...r, ...next]);
      k--;
    }
  }

  return merged.map((r) => makeSegment(tokens, words[r[0]].i, words[r[r.length - 1]].i));
}

/** Builds a segment spanning tokens[fromIdx..toIdx] (inclusive), keeping original spacing. */
export function makeSegment(tokens: TimedToken[], fromIdx: number, toIdx: number): Segment {
  let text = "";
  for (let i = fromIdx; i <= toIdx; i++) text += tokens[i].text;
  return {
    id: newSegmentId(),
    start: tokens[fromIdx].start,
    end: tokens[toIdx].end,
    text: text.replace(/\s+/g, " ").trim(),
  };
}

/** Indices of word tokens whose midpoint lies within [start, end]. */
export function wordsInRange(tokens: TimedToken[], start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "word") continue;
    const mid = (t.start + t.end) / 2;
    if (mid >= start - 1e-6 && mid <= end + 1e-6) out.push(i);
  }
  return out;
}

/** Splits a segment at the largest internal pause. Returns null if it has fewer than two words. */
export function splitSegment(tokens: TimedToken[], seg: Segment): [Segment, Segment] | null {
  const idx = wordsInRange(tokens, seg.start, seg.end);
  if (idx.length < 2) return null;
  let best = 0;
  let bestScore = -Infinity;
  const mid = (seg.start + seg.end) / 2;
  const dur = seg.end - seg.start || 1;
  for (let k = 0; k < idx.length - 1; k++) {
    const w = tokens[idx[k]];
    const n = tokens[idx[k + 1]];
    let score = Math.max(0, n.start - w.end) * 2;
    if (SENTENCE_END.test(w.text)) score += 1.5;
    else if (CLAUSE_END.test(w.text)) score += 1.0;
    score -= Math.abs(w.end - mid) / dur;
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  const a = makeSegment(tokens, idx[0], idx[best]);
  const b = makeSegment(tokens, idx[best + 1], idx[idx.length - 1]);
  return [a, b];
}

/** Merges two adjacent segments. */
export function mergeSegments(a: Segment, b: Segment, charBased: boolean): Segment {
  return {
    id: newSegmentId(),
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    text: charBased ? a.text + b.text : `${a.text} ${b.text}`.trim(),
  };
}
