import { describe, expect, it } from "vitest";
import { mergeSegments, segmentTokens, splitSegment } from "./segmenter";
import type { TimedToken } from "../types";

/** Fake ASR output: fixed word durations, longer pause after sentence-final punctuation. */
export function fakeWords(text: string, charBased = false): TimedToken[] {
  const out: TimedToken[] = [];
  let t = 0;
  const units = charBased ? Array.from(text.replace(/\s+/g, "")) : text.split(/\s+/);
  units.forEach((u, i) => {
    const dur = charBased ? 0.15 : 0.3;
    out.push({ text: u, start: t, end: t + dur, type: "word" });
    t += dur;
    const gap = /[.!?。！？]$/.test(u) ? 0.8 : 0.05;
    if (i < units.length - 1) {
      if (!charBased) out.push({ text: " ", start: t, end: t + gap, type: "spacing" });
      t += gap;
    }
  });
  return out;
}

const fr =
  "Bonjour à tous et bienvenue dans ce nouvel épisode. Aujourd'hui, nous allons parler de la cuisine française, de ses traditions régionales, de ses fromages, de ses vins et bien sûr de ses desserts qui font le tour du monde depuis des siècles. C'est parti !";

describe("segmentTokens", () => {
  it("breaks at sentence ends and respects the maximum length", () => {
    const segs = segmentTokens(fakeWords(fr), { maxPhraseSec: 5, minPhraseSec: 1.2 });
    expect(segs.length).toBeGreaterThan(3);
    for (const s of segs) expect(s.end - s.start).toBeLessThanOrEqual(5.01);
    expect(segs[0].text).toBe("Bonjour à tous et bienvenue dans ce nouvel épisode.");
    // Long sentence splits at clause punctuation (commas).
    const longOnes = segs.slice(1, -1);
    expect(longOnes.some((s) => /,$/.test(s.text))).toBe(true);
  });

  it("covers every word exactly once in order", () => {
    const words = fakeWords(fr);
    const segs = segmentTokens(words, { maxPhraseSec: 6, minPhraseSec: 1 });
    expect(segs.map((s) => s.text).join(" ")).toBe(fr);
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBeGreaterThanOrEqual(segs[i - 1].end - 1e-9);
  });

  it("merges very short phrases into neighbours", () => {
    const words = fakeWords("Oui. Non. Peut-être que nous verrons demain matin.");
    const segs = segmentTokens(words, { maxPhraseSec: 8, minPhraseSec: 1.5 });
    expect(segs.length).toBe(1);
  });

  it("handles Japanese without spaces", () => {
    const ja = "今日は天気がいいですね。散歩に行きましょう。それから、カフェでコーヒーを飲みましょう。";
    const segs = segmentTokens(fakeWords(ja, true), { maxPhraseSec: 4, minPhraseSec: 1 });
    expect(segs.map((s) => s.text).join("")).toBe(ja);
    expect(segs[0].text).toBe("今日は天気がいいですね。");
  });

  it("ignores audio events and empty tokens", () => {
    const words = fakeWords("Bonjour tout le monde.");
    words.unshift({ text: "(music)", start: 0, end: 0.1, type: "audio_event" });
    const segs = segmentTokens(words, { maxPhraseSec: 8, minPhraseSec: 1 });
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("Bonjour tout le monde.");
  });
});

describe("splitSegment / mergeSegments", () => {
  it("splits at the best pause and merges back", () => {
    const words = fakeWords(fr);
    const [seg] = segmentTokens(words, { maxPhraseSec: 60, minPhraseSec: 1 });
    const parts = splitSegment(words, seg);
    expect(parts).not.toBeNull();
    const [a, b] = parts!;
    expect(a.end).toBeLessThanOrEqual(b.start + 1e-9);
    expect(`${a.text} ${b.text}`).toBe(seg.text);
    const merged = mergeSegments(a, b, false);
    expect(merged.text).toBe(seg.text);
    expect(merged.start).toBe(seg.start);
    expect(merged.end).toBe(seg.end);
  });

  it("refuses to split a single word", () => {
    const words = fakeWords("Bonjour.");
    const [seg] = segmentTokens(words, { maxPhraseSec: 8, minPhraseSec: 0.1 });
    expect(splitSegment(words, seg)).toBeNull();
  });
});
