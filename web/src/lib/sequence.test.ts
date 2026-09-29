import { describe, expect, it } from "vitest";
import { PAUSE_BEFORE_ENGLISH_SEC, gapSeconds, nextAction, sourceRate, stepsAfterSource } from "./sequence";
import { DEFAULT_SETTINGS, type PracticeSettings } from "../types";

const s = (patch: Partial<PracticeSettings>): PracticeSettings => ({ ...DEFAULT_SETTINGS, ...patch });
const seg = { id: "a", start: 10, end: 12, text: "x" };

describe("gapSeconds", () => {
  it("scales the phrase length by rate and gap factor", () => {
    expect(gapSeconds(seg, s({ rate: 1, gapFactor: 1.5 }))).toBeCloseTo(3);
    expect(gapSeconds(seg, s({ rate: 0.5, gapFactor: 1 }))).toBeCloseTo(4);
  });
  it("never drops below 0.4s", () => {
    expect(gapSeconds({ ...seg, end: 10.05 }, s({ gapFactor: 1 }))).toBe(0.4);
  });
});

describe("sourceRate", () => {
  const auto = s({ mode: "auto", rate: 1, slowPlays: 2, slowRate: 0.75 });
  it("slows the first plays in auto and loop modes", () => {
    expect([1, 2, 3, 4].map((n) => sourceRate(auto, n))).toEqual([0.75, 0.75, 1, 1]);
    expect(sourceRate({ ...auto, mode: "loop" }, 2)).toBe(0.75);
  });
  it("never slows manual plays", () => {
    expect(sourceRate({ ...auto, mode: "manual" }, 1)).toBe(1);
  });
  it("is off at zero slow plays", () => {
    expect(sourceRate({ ...auto, slowPlays: 0 }, 1)).toBe(1);
  });
  it("never speeds up past the normal rate", () => {
    expect(sourceRate({ ...auto, rate: 0.7 }, 1)).toBe(0.7);
  });
  it("treats settings saved before slow plays existed as off", () => {
    const old = { ...auto } as Partial<PracticeSettings>;
    delete old.slowPlays;
    delete old.slowRate;
    expect(sourceRate(old as PracticeSettings, 1)).toBe(1);
  });
});

describe("gapSeconds with slow plays", () => {
  it("sizes the gap to the speed the phrase was played at", () => {
    const auto = s({ mode: "auto", rate: 1, gapFactor: 1, slowPlays: 1, slowRate: 0.5 });
    expect(gapSeconds(seg, auto, 1)).toBeCloseTo(4);
    expect(gapSeconds(seg, auto, 2)).toBeCloseTo(2);
  });
});

describe("stepsAfterSource", () => {
  const pause = { kind: "pause", sec: PAUSE_BEFORE_ENGLISH_SEC };
  const clip = { kind: "clip", clip: "en" };
  const gap = { kind: "gap" };
  it("has no steps in manual mode", () => {
    expect(stepsAfterSource(s({ mode: "manual" }), 1)).toEqual([]);
  });
  it("leaves a gap in auto and loop modes", () => {
    expect(stepsAfterSource(s({ mode: "auto" }), 1)).toEqual([gap]);
    expect(stepsAfterSource(s({ mode: "loop" }), 1)).toEqual([gap]);
  });
  it("plays English between the phrase and the gap", () => {
    expect(stepsAfterSource(s({ mode: "auto", english: "each" }), 1)).toEqual([pause, clip, gap]);
    expect(stepsAfterSource(s({ mode: "auto", english: "each" }), 3)).toEqual([pause, clip, gap]);
  });
  it("plays English only after the first play when set to first", () => {
    expect(stepsAfterSource(s({ mode: "auto", english: "first" }), 1)).toEqual([pause, clip, gap]);
    expect(stepsAfterSource(s({ mode: "auto", english: "first" }), 2)).toEqual([gap]);
    expect(stepsAfterSource(s({ mode: "loop", english: "first" }), 2)).toEqual([gap]);
  });
  it("plays English then stops in manual mode", () => {
    expect(stepsAfterSource(s({ mode: "manual", english: "first" }), 1)).toEqual([pause, clip]);
  });
  it("treats settings saved before English existed as off", () => {
    const old = { ...DEFAULT_SETTINGS, mode: "auto" } as Partial<PracticeSettings>;
    delete old.english;
    expect(stepsAfterSource(old as PracticeSettings, 1)).toEqual([gap]);
  });
});

describe("nextAction", () => {
  it("stops in manual mode", () => {
    expect(nextAction(s({ mode: "manual" }), 0, 0, 5)).toEqual({ kind: "stop" });
  });
  it("replays forever in loop mode", () => {
    expect(nextAction(s({ mode: "loop" }), 7, 4, 5)).toEqual({ kind: "replay", keepPlays: true });
  });
  it("repeats in auto mode until the count is reached, then advances", () => {
    const auto = s({ mode: "auto", repeats: 3 });
    expect(nextAction(auto, 1, 0, 5)).toEqual({ kind: "replay", keepPlays: true });
    expect(nextAction(auto, 2, 0, 5)).toEqual({ kind: "replay", keepPlays: true });
    expect(nextAction(auto, 3, 0, 5)).toEqual({ kind: "advance" });
  });
  it("stops after the last phrase", () => {
    expect(nextAction(s({ mode: "auto", repeats: 1 }), 1, 4, 5)).toEqual({ kind: "stop" });
  });
  it("treats odd repeat values as at least one play", () => {
    expect(nextAction(s({ mode: "auto", repeats: 0 }), 1, 0, 5)).toEqual({ kind: "advance" });
  });
});
