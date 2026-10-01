import { describe, expect, it } from "vitest";
import { coverageByEpisode, drillCoverage, formatCoverage } from "./coverage";

describe("drillCoverage", () => {
  it("is undefined without excerpts", () => {
    expect(drillCoverage(600, [])).toBeUndefined();
  });

  it("measures the share of the episode inside excerpts", () => {
    const c = drillCoverage(2504, [{ start: 83, end: 201 }])!;
    expect(c.fraction).toBeCloseTo(118 / 2504);
    expect(c.full).toBe(false);
  });

  it("counts overlapping and touching excerpts once", () => {
    const c = drillCoverage(100, [
      { start: 10, end: 40 },
      { start: 30, end: 50 },
      { start: 50, end: 60 },
      { start: 20, end: 25 },
    ])!;
    expect(c.fraction).toBeCloseTo(0.5);
  });

  it("counts a short lesson as all in drills when only its spoken number is left out", () => {
    expect(drillCoverage(27.56, [{ start: 1.58, end: 27.56 }])!.full).toBe(true);
    expect(drillCoverage(37.46, [{ start: 1.62, end: 37.46 }])!.full).toBe(true);
  });

  it("counts a long episode as all in drills when only an intro's worth is left out", () => {
    expect(drillCoverage(2400, [{ start: 60, end: 1200 }, { start: 1201, end: 2380 }])!.full).toBe(true);
    expect(drillCoverage(2400, [{ start: 60, end: 1200 }, { start: 1300, end: 2400 }])!.full).toBe(false);
  });

  it("doesn't count a lesson as all in drills when a real part is left out", () => {
    expect(drillCoverage(60, [{ start: 1.5, end: 45 }])!.full).toBe(false);
  });

  it("ignores excerpt time beyond the episode's end", () => {
    expect(drillCoverage(30, [{ start: 0, end: 45 }])).toEqual({ fraction: 1, full: true });
  });

  it("falls back to the excerpts' extent when the length is unknown", () => {
    expect(drillCoverage(undefined, [{ start: 0, end: 45 }])!.full).toBe(true);
  });
});

describe("coverageByEpisode", () => {
  it("covers only episodes with excerpts", () => {
    const m = coverageByEpisode(
      [
        { id: "a", durationSec: 100 },
        { id: "b", durationSec: 100 },
      ],
      [
        { episodeId: "a", start: 0, end: 20 },
        { episodeId: "a", start: 50, end: 70 },
        { episodeId: "gone", start: 0, end: 10 },
      ],
    );
    expect([...m.keys()]).toEqual(["a"]);
    expect(m.get("a")!.fraction).toBeCloseTo(0.4);
  });
});

describe("formatCoverage", () => {
  it("rounds to a whole percentage, never below 1%", () => {
    expect(formatCoverage({ fraction: 0.047, full: false })).toBe("5% in drills");
    expect(formatCoverage({ fraction: 0.001, full: false })).toBe("1% in drills");
    expect(formatCoverage({ fraction: 0.96, full: true })).toBe("All in drills");
  });
});
