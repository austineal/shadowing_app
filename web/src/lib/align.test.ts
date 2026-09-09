import { describe, expect, it } from "vitest";
import { alignTranscript, normalizeToken, tokenizeTranscript } from "./align";
import { segmentTokens } from "./segmenter";
import { fakeWords } from "./segmenter.test";

describe("normalizeToken / tokenizeTranscript", () => {
  it("strips punctuation and case", () => {
    expect(normalizeToken("Épisode,")).toBe("épisode");
    expect(normalizeToken("«Bonjour»")).toBe("bonjour");
    expect(normalizeToken("—")).toBe("");
  });

  it("glues punctuation-only tokens to neighbours", () => {
    const toks = tokenizeTranscript("— Bonjour , tout le monde !", "fr");
    expect(toks.map((t) => t.text)).toEqual(["— Bonjour ,", "tout", "le", "monde !"]);
  });

  it("splits Japanese into characters, attaching punctuation", () => {
    const toks = tokenizeTranscript("今日は、いい天気。", "ja");
    expect(toks.map((t) => t.text)).toEqual(["今", "日", "は、", "い", "い", "天", "気。"]);
  });
});

describe("alignTranscript", () => {
  it("transfers timestamps and interpolates unmatched words", () => {
    const asr = "Bonjour à tous euh et bienvenue dans ce nouvelle épisode. Aujourd'hui nous allons parler de la cuisine française.";
    const user = "Bonjour à tous et bienvenue dans ce nouvel épisode. Aujourd'hui, nous allons parler de la (belle) cuisine française.";
    const asrWords = fakeWords(asr);
    const r = alignTranscript(user, asrWords, "fr");
    expect(r.total).toBe(18);
    expect(r.matched).toBe(16); // "nouvel" and "(belle)" have no ASR match
    const words = r.tokens.filter((t) => t.type === "word");
    expect(words.map((w) => w.text).join(" ")).toBe(user);
    // Monotonic, non-negative times.
    for (let i = 0; i < words.length; i++) {
      expect(words[i].end).toBeGreaterThanOrEqual(words[i].start);
      if (i) expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start - 1e-9);
    }
    // "Bonjour" inherits the ASR time exactly.
    expect(words[0].start).toBe(asrWords[0].start);
    // The unmatched "nouvel" sits between "ce" and "épisode".
    const ce = words.find((w) => w.text === "ce")!;
    const nouvel = words.find((w) => w.text === "nouvel")!;
    const episode = words.find((w) => w.text === "épisode.")!;
    expect(nouvel.start).toBeGreaterThanOrEqual(ce.end - 1e-9);
    expect(nouvel.end).toBeLessThanOrEqual(episode.start + 1e-9);
    // Segments built from aligned tokens use the user's wording.
    const segs = segmentTokens(r.tokens, { maxPhraseSec: 8, minPhraseSec: 1 });
    expect(segs[0].text).toBe("Bonjour à tous et bienvenue dans ce nouvel épisode.");
  });

  it("aligns Japanese by character", () => {
    const ja = "今日は天気がいいですね。散歩に行きましょう。";
    const r = alignTranscript("今日は天気が良いですね。散歩に行きましょう。", fakeWords(ja, true), "ja");
    expect(r.matchRatio).toBeGreaterThan(0.85);
    const segs = segmentTokens(r.tokens, { maxPhraseSec: 5, minPhraseSec: 0.5 });
    expect(segs.map((s) => s.text)).toEqual(["今日は天気が良いですね。", "散歩に行きましょう。"]);
  });

  it("handles a transcript with nothing in common", () => {
    const r = alignTranscript("completely different words here", fakeWords("Bonjour à tous."), "fr");
    expect(r.matchRatio).toBe(0);
    expect(r.tokens.filter((t) => t.type === "word")).toHaveLength(4);
  });
});
