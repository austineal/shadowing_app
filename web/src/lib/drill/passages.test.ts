import { describe, expect, it } from "vitest";
import { phraseBefore, phrasesIn, splitPassages } from "./passages";

/** Phrases of `sec` seconds separated by `gap`-second pauses, optionally overridden per index. */
function phrases(count: number, sec = 7, gap = 0.3, pauses: Record<number, number> = {}) {
  const out = [];
  let t = 100;
  for (let i = 0; i < count; i++) {
    out.push({ start: t, end: t + sec, text: `phrase ${i}` });
    t += sec + (pauses[i] ?? gap);
  }
  return out;
}

describe("splitPassages", () => {
  it("cuts an excerpt into passages of about 40 seconds that tile it", () => {
    const ps = phrases(30);
    const passages = splitPassages(ps);
    expect(passages[0].start).toBe(ps[0].start);
    expect(passages[passages.length - 1].end).toBe(ps[29].end);
    for (let k = 1; k < passages.length; k++) expect(passages[k].start).toBe(passages[k - 1].end);
    for (const p of passages) {
      expect(p.end - p.start).toBeGreaterThan(25);
      expect(p.end - p.start).toBeLessThanOrEqual(61);
    }
    // Every phrase lands in exactly one passage.
    const counts = passages.map((p) => phrasesIn(ps, p.start, p.end).length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(30);
  });

  it("prefers to break at a long pause", () => {
    const ps = phrases(10, 7, 0.2, { 3: 2 }); // long pause after phrase 3 (about 29 s in)
    const passages = splitPassages(ps);
    expect(phrasesIn(ps, passages[0].start, passages[0].end)).toHaveLength(4);
  });

  it("prefers to break after a full sentence", () => {
    const ps = phrases(10, 7, 0.3);
    ps[4].text = "the end of a sentence.";
    const passages = splitPassages(ps);
    expect(phrasesIn(ps, passages[0].start, passages[0].end)).toHaveLength(5);
  });

  it("keeps a single phrase longer than the maximum as its own passage", () => {
    const ps = [
      { start: 0, end: 5, text: "a" },
      { start: 5.5, end: 80, text: "very long" },
      { start: 80.5, end: 85, text: "c" },
    ];
    const passages = splitPassages(ps);
    expect(passages.some((p) => phrasesIn(ps, p.start, p.end).length === 1 && p.end - p.start > 60)).toBe(true);
  });

  it("folds a short tail into the passage before it", () => {
    const ps = phrases(7); // about 51 s: one passage is better than 40 s + 11 s
    expect(splitPassages(ps)).toHaveLength(1);
  });

  it("returns nothing for no phrases", () => {
    expect(splitPassages([])).toEqual([]);
  });
});

describe("phraseBefore", () => {
  it("finds the last phrase before a time", () => {
    const ps = phrases(5);
    expect(phraseBefore(ps, ps[2].start)).toBe(ps[1]);
    expect(phraseBefore(ps, ps[0].start)).toBeUndefined();
  });
});
