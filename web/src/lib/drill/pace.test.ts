import { describe, expect, it } from "vitest";
import { drillMinutesPerAudioMinute, excerptMinutes, formatLearningTime, weeklyPace } from "./pace";
import { drillOptions } from "./steps";
import type { DrillSchedule, DrillSessionLog } from "../../types";

const base = { paddingMs: 120, gapFactor: 1.3 };
const full = drillOptions("full", base);
const light = drillOptions("light", base);
const DAY = 86_400_000;
const now = new Date(2026, 9, 1, 12).getTime();

const schedule = (patch: Partial<DrillSchedule>): DrillSchedule => ({
  perDay: 1,
  everyDays: 1,
  minutes: 30,
  newMaterial: true,
  learning: "full",
  ...patch,
});
const log = (daysAgo: number, learnedSeconds?: number): DrillSessionLog => ({
  id: String(daysAgo),
  language: "cy",
  startedAt: now - daysAgo * DAY,
  endedAt: now - daysAgo * DAY + 30 * 60_000,
  progress: 1,
  reviewed: 0,
  passed: 0,
  learnedPhrases: 0,
  ...(learnedSeconds === undefined ? {} : { learnedSeconds }),
});

describe("drillMinutesPerAudioMinute", () => {
  it("takes longer to learn with the full drill than the light one", () => {
    expect(drillMinutesPerAudioMinute(full)).toBeGreaterThan(drillMinutesPerAudioMinute(light));
    expect(drillMinutesPerAudioMinute(full)).toBeGreaterThan(15);
    expect(drillMinutesPerAudioMinute(light)).toBeLessThan(30);
  });
});

describe("weeklyPace", () => {
  it("estimates from the schedule, sizing excerpts to about two weeks", () => {
    const japanese = weeklyPace(schedule({ perDay: 2, minutes: 30 }), [], full, now);
    const welsh = weeklyPace(schedule({ minutes: 30 }), [], full, now);
    const french = weeklyPace(schedule({ everyDays: 2, minutes: 20, learning: "light" }), [], light, now);
    expect(japanese.measured).toBe(false);
    expect(japanese.perWeek).toBeCloseTo(welsh.perWeek * 2);
    // Roughly what the load model found: minutes of new audio a week.
    expect(excerptMinutes(japanese)).toBeGreaterThanOrEqual(10);
    expect(excerptMinutes(welsh)).toBeGreaterThanOrEqual(5);
    expect(excerptMinutes(welsh)).toBeLessThanOrEqual(10);
    expect(excerptMinutes(french)).toBeGreaterThanOrEqual(2);
    expect(excerptMinutes(french)).toBeLessThanOrEqual(4);
  });

  it("doesn't count sessions abandoned before anything was done", () => {
    const abandoned = { ...log(20, 0), progress: 0 };
    expect(weeklyPace(schedule({}), [abandoned, log(3, 300)], full, now).measured).toBe(false);
  });

  it("measures from the logs once they go back two weeks", () => {
    const logs = [log(21, 300), log(14, 300), log(3, 300), log(1)];
    const pace = weeklyPace(schedule({}), logs, full, now);
    expect(pace.measured).toBe(true);
    expect(pace.perWeek).toBeCloseTo(900 / 3); // 900 s over three weeks
  });

  it("keeps estimating while the history is short or predates the measurement", () => {
    expect(weeklyPace(schedule({}), [log(10, 600), log(2, 600)], full, now).measured).toBe(false);
    expect(weeklyPace(schedule({}), [log(20), log(2)], full, now).measured).toBe(false);
  });

  it("doesn't let a lull shrink the pace below a quarter of the estimate", () => {
    const estimate = weeklyPace(schedule({}), [], full, now).perWeek;
    expect(weeklyPace(schedule({}), [log(20, 0), log(2, 0)], full, now).perWeek).toBeCloseTo(estimate / 4);
  });
});

describe("excerptMinutes and formatLearningTime", () => {
  const pace = { perWeek: 240, measured: true }; // 4 minutes a week
  it("suggests two weeks' worth, between 2 and 20 minutes", () => {
    expect(excerptMinutes(pace)).toBe(8);
    expect(excerptMinutes({ perWeek: 10, measured: true })).toBe(2);
    expect(excerptMinutes({ perWeek: 6000, measured: true })).toBe(20);
  });
  it("describes learning times in days or weeks", () => {
    expect(formatLearningTime(60, pace)).toBe("about 2 days");
    expect(formatLearningTime(240, pace)).toBe("about a week");
    expect(formatLearningTime(720, pace)).toBe("about 3 weeks");
  });
});
