import { diffArrays } from "diff";
import type { TimedToken } from "../types";
import { isCharBased } from "./languages";

/**
 * Aligns a user-supplied transcript to speech-recognition words so the
 * transcript's own wording inherits timestamps. Works by diffing normalised
 * token sequences (words, or characters for Japanese/Chinese) and
 * interpolating times for transcript tokens the recogniser missed.
 */

interface UserToken {
  text: string;
  norm: string;
  start?: number;
  end?: number;
}

interface AsrToken {
  norm: string;
  start: number;
  end: number;
}

export interface AlignmentResult {
  tokens: TimedToken[];
  /** Fraction of transcript tokens directly matched to recognised speech. */
  matchRatio: number;
  matched: number;
  total: number;
}

const PUNCT_RE = /[\p{P}\p{S}]/gu;

export function normalizeToken(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(PUNCT_RE, "").replace(/\s+/g, "");
}

/** Splits the user's transcript into comparable tokens, attaching punctuation-only bits to neighbours. */
export function tokenizeTranscript(text: string, language: string): UserToken[] {
  const charBased = isCharBased(language);
  const raw = charBased
    ? Array.from(text.replace(/\s+/g, ""))
    : text.split(/\s+/).filter(Boolean);

  const out: UserToken[] = [];
  let pendingPrefix = "";
  for (const r of raw) {
    const norm = normalizeToken(r);
    if (!norm) {
      // Punctuation-only: glue to previous token, or hold for the next one.
      if (out.length) out[out.length - 1].text += charBased ? r : ` ${r}`;
      else pendingPrefix += charBased ? r : `${r} `;
      continue;
    }
    out.push({ text: pendingPrefix + r, norm });
    pendingPrefix = "";
  }
  if (pendingPrefix && out.length) out[0].text = pendingPrefix + out[0].text;
  return out;
}

function asrTokens(words: TimedToken[], language: string): AsrToken[] {
  const charBased = isCharBased(language);
  const out: AsrToken[] = [];
  for (const w of words) {
    if (w.type !== "word") continue;
    if (charBased) {
      const chars = Array.from(w.text).filter((c) => normalizeToken(c));
      const step = chars.length ? (w.end - w.start) / chars.length : 0;
      chars.forEach((c, i) => {
        out.push({ norm: normalizeToken(c), start: w.start + step * i, end: w.start + step * (i + 1) });
      });
    } else {
      const norm = normalizeToken(w.text);
      if (norm) out.push({ norm, start: w.start, end: w.end });
    }
  }
  return out;
}

export function alignTranscript(transcript: string, words: TimedToken[], language: string): AlignmentResult {
  const charBased = isCharBased(language);
  const user = tokenizeTranscript(transcript, language);
  const asr = asrTokens(words, language);
  if (user.length === 0) return { tokens: [], matchRatio: 0, matched: 0, total: 0 };

  const parts = diffArrays(
    asr.map((t) => t.norm),
    user.map((t) => t.norm),
  );

  let ai = 0;
  let ui = 0;
  let matched = 0;
  for (const part of parts) {
    const len = part.value.length;
    if (part.removed) {
      ai += len;
    } else if (part.added) {
      ui += len;
    } else {
      for (let k = 0; k < len; k++) {
        user[ui].start = asr[ai].start;
        user[ui].end = asr[ai].end;
        matched++;
        ai++;
        ui++;
      }
    }
  }

  interpolateGaps(user, asr);

  // Build TimedToken[] with spacing tokens between words for spaced languages.
  const tokens: TimedToken[] = [];
  for (let i = 0; i < user.length; i++) {
    const u = user[i];
    tokens.push({ text: u.text, start: u.start!, end: u.end!, type: "word" });
    if (!charBased && i < user.length - 1) {
      tokens.push({ text: " ", start: u.end!, end: user[i + 1].start!, type: "spacing" });
    }
  }
  return { tokens, matchRatio: matched / user.length, matched, total: user.length };
}

/** Assigns times to unmatched tokens by spreading them across the surrounding gap, weighted by length. */
function interpolateGaps(user: UserToken[], asr: AsrToken[]): void {
  const n = user.length;
  const audioEnd = asr.length ? asr[asr.length - 1].end : 0;
  let i = 0;
  while (i < n) {
    if (user[i].start !== undefined) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && user[j].start === undefined) j++;
    // Unknown run is [i, j).
    const prevEnd = i > 0 ? user[i - 1].end! : undefined;
    const nextStart = j < n ? user[j].start! : undefined;
    const runLen = j - i;
    const estimate = runLen * 0.35; // rough seconds per token when nothing to anchor to
    let from: number;
    let to: number;
    if (prevEnd !== undefined && nextStart !== undefined) {
      from = prevEnd;
      to = Math.max(nextStart, prevEnd + 0.05 * runLen);
    } else if (prevEnd !== undefined) {
      from = prevEnd;
      to = Math.min(Math.max(prevEnd + estimate, prevEnd + 0.05 * runLen), Math.max(audioEnd, prevEnd + 0.05 * runLen));
    } else if (nextStart !== undefined) {
      to = nextStart;
      from = Math.max(0, nextStart - estimate);
    } else {
      from = 0;
      to = Math.max(audioEnd, estimate);
    }
    const weights = user.slice(i, j).map((u) => Math.max(1, u.norm.length));
    const total = weights.reduce((a, b) => a + b, 0);
    let t = from;
    for (let k = i; k < j; k++) {
      const w = ((to - from) * weights[k - i]) / total;
      user[k].start = t;
      user[k].end = t + w;
      t += w;
    }
    i = j;
  }
}
