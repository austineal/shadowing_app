import { describe, expect, it } from "vitest";
import { drillOptions, speakSeconds, testSteps } from "./steps";

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
