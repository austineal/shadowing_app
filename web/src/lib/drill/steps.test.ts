import { describe, expect, it } from "vitest";
import { cueGroups, cueSize, drillOptions, speakSeconds, testSteps, type SessionPhrase } from "./steps";

describe("speakSeconds", () => {
  it("gives more time early on, and extra on request", () => {
    expect(speakSeconds(4, 0)).toBeCloseTo(8);
    expect(speakSeconds(4, 2)).toBeCloseTo(6.8);
    expect(speakSeconds(4, 5)).toBeCloseTo(5.8);
    expect(speakSeconds(4, 0, 2)).toBeCloseTo(10);
  });
});

describe("testSteps", () => {
  it("uses the language's extra answer time for the speaking pause", () => {
    const base = { paddingMs: 0, gapFactor: 1.3 };
    const p = { start: 0, end: 4, text: "x", english: "y" };
    const pause = (extra: number) => testSteps("ep", [p], 0, drillOptions("full", base, extra)).find((s) => s.cue === "speak")!.play;
    expect(pause(0)).toEqual({ kind: "silence", sec: 8 });
    expect(pause(3)).toEqual({ kind: "silence", sec: 11 });
  });
  it("leaves two seconds after the answer to press Missed", () => {
    const steps = testSteps("ep", [{ start: 0, end: 4, text: "x", english: "y" }], 0, drillOptions("full", { paddingMs: 0, gapFactor: 1 }));
    expect(steps[steps.length - 1]).toMatchObject({ cue: "answer", play: { kind: "silence", sec: 2 } });
  });
});

describe("cueGroups", () => {
  /** Phrases of the given lengths with half-second pauses between them; a "." ends a sentence. */
  function spoken(...parts: [text: string, sec: number][]): SessionPhrase[] {
    let t = 0;
    return parts.map(([text, sec], i) => {
      const p = { start: t, end: t + sec, text, english: `e${i}` };
      t += sec + 0.5;
      return p;
    });
  }

  it("grows from phrases to sentences to runs of sentences as the level rises", () => {
    expect([0, 1, 2, 3, 4, 8].map(cueSize)).toEqual(["phrase", "phrase", "sentence", "sentence", "turn", "turn"]);
  });

  it("cues each phrase alone at phrase size", () => {
    const ps = spoken(["a", 3], ["b.", 3]);
    expect(cueGroups(ps, "phrase")).toEqual([[0], [1]]);
  });

  it("joins phrases up to the end of their sentence", () => {
    const ps = spoken(["a,", 3], ["b.", 4], ["c", 3], ["d。", 4], ["e?", 7]);
    expect(cueGroups(ps, "sentence")).toEqual([[0, 1], [2, 3], [4]]);
  });

  it("joins short sentences until a cue is about six seconds", () => {
    const ps = spoken(["Yes.", 1], ["Right.", 1.5], ["I see.", 4], ["And then?", 7], ["No.", 1]);
    expect(cueGroups(ps, "sentence")).toEqual([[0, 1, 2], [3], [4]]);
  });

  it("doesn't join sentences over a long pause", () => {
    const ps = spoken(["Yes.", 1], ["Right.", 2]);
    ps[1] = { ...ps[1], start: ps[0].end + 1.5, end: ps[0].end + 3.5 };
    expect(cueGroups(ps, "sentence")).toEqual([[0], [1]]);
  });

  it("cues a long sentence in parts", () => {
    const ps = spoken(["a", 7], ["b", 7], ["c", 7], ["d.", 3]);
    expect(cueGroups(ps, "sentence")).toEqual([[0, 1], [2, 3]]);
  });

  it("leaves a phrase without English on its own", () => {
    const ps = spoken(["a", 3], ["b", 3], ["c.", 3]);
    ps[1].english = undefined;
    expect(cueGroups(ps, "sentence")).toEqual([[0], [1], [2]]);
    expect(cueGroups(ps, "turn")).toEqual([[0], [1], [2]]);
  });

  it("runs sentences together up to 20 seconds, breaking at a long pause", () => {
    const ps = spoken(["a.", 6], ["b.", 6], ["c.", 6], ["d.", 4], ["e.", 4]);
    expect(cueGroups(ps, "turn")).toEqual([[0, 1, 2], [3, 4]]);
    ps[4] = { ...ps[4], start: ps[3].end + 1.5, end: ps[3].end + 5.5 };
    expect(cueGroups(ps, "turn")).toEqual([[0, 1, 2], [3], [4]]);
  });
});
