import { describe, expect, it } from "vitest";
import { gapSeconds, nextAction, stepsAfterSource } from "./sequence";
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

describe("stepsAfterSource", () => {
  it("has no steps in manual mode", () => {
    expect(stepsAfterSource(s({ mode: "manual" }))).toEqual([]);
  });
  it("leaves a gap in auto and loop modes", () => {
    expect(stepsAfterSource(s({ mode: "auto" }))).toEqual([{ kind: "gap" }]);
    expect(stepsAfterSource(s({ mode: "loop" }))).toEqual([{ kind: "gap" }]);
  });
});

describe("nextAction", () => {
  it("stops in manual mode", () => {
    expect(nextAction(s({ mode: "manual" }), 0, 0, 5)).toEqual({ kind: "stop" });
  });
  it("replays forever in loop mode", () => {
    expect(nextAction(s({ mode: "loop" }), 0, 4, 5)).toEqual({ kind: "replay", keepPlays: false });
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
