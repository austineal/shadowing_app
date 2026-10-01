import { describe, expect, it } from "vitest";
import {
  bookNewPassage,
  bookedByDay,
  forecastLoad,
  overfilledBy,
  reviewSeconds,
  sessionDayFrom,
  sessionDays,
  spreadReviews,
  type SessionDay,
} from "./forecast";
import { dayNumber, learnedPassage } from "./srs";
import { drillOptions } from "./steps";
import type { DrillPassage, DrillSchedule } from "../../types";

const opts = drillOptions("full", { paddingMs: 120, gapFactor: 1.3 });
const schedule = (patch: Partial<DrillSchedule> = {}): DrillSchedule => ({
  perDay: 1,
  everyDays: 1,
  minutes: 20,
  newMaterial: true,
  learning: "full",
  ...patch,
});
const at = (day: number, hour: number) => new Date(2026, 4, 10 + day, hour).getTime();
const now = at(0, 9);
const today = dayNumber(now);
const session = (day: number, hour: number) => ({ startedAt: at(day, hour), endedAt: at(day, hour) + 30 * 60_000 });
const days = (list: SessionDay[]) => list.map((d) => `${d.day - today}${d.sessions > 1 ? `x${d.sessions}` : ""}`);

describe("sessionDays", () => {
  it("lists every day for a daily language, today while its session is still to come", () => {
    expect(days(sessionDays(schedule(), [], now, 4))).toEqual(["0", "1", "2", "3"]);
    expect(days(sessionDays(schedule(), [session(0, 8)], now, 4))).toEqual(["1", "2", "3"]);
    expect(sessionDays(schedule(), [], now, 1)[0].capacitySec).toBe(20 * 60);
  });

  it("counts the sessions left today for a language drilled twice a day", () => {
    const twice = schedule({ perDay: 2, minutes: 30 });
    const list = sessionDays(twice, [session(0, 7)], now, 3);
    expect(days(list)).toEqual(["0", "1x2", "2x2"]);
    expect(list[1].capacitySec).toBe(60 * 60);
  });

  it("follows the turns of a language drilled every few days", () => {
    const alternate = schedule({ everyDays: 2, anchorDay: today });
    expect(days(sessionDays(alternate, [], now, 6))).toEqual(["0", "2", "4"]);
    expect(days(sessionDays(alternate, [session(0, 8)], now, 6))).toEqual(["2", "4"]);
    // A turn missed yesterday is still owed today.
    const yesterday = schedule({ everyDays: 2, anchorDay: today - 1 });
    expect(days(sessionDays(yesterday, [], now, 4))).toEqual(["0", "1", "3"]);
    // Set up to start tomorrow.
    expect(days(sessionDays(schedule({ everyDays: 3, anchorDay: today + 1 }), [], now, 6))).toEqual(["1", "4"]);
  });

  it("finds the session day on or after a day", () => {
    expect(sessionDayFrom(schedule(), today + 3)).toBe(today + 3);
    const alternate = schedule({ everyDays: 2, anchorDay: today });
    expect(sessionDayFrom(alternate, today + 3)).toBe(today + 4);
    expect(sessionDayFrom(alternate, today + 4)).toBe(today + 4);
    expect(sessionDayFrom(schedule({ everyDays: 7, anchorDay: today + 2 }), today)).toBe(today + 2);
  });
});

describe("reviewSeconds", () => {
  it("grows with the passage and shrinks as it matures", () => {
    expect(reviewSeconds(40, 0, opts)).toBeGreaterThan(reviewSeconds(20, 0, opts));
    expect(reviewSeconds(40, 4, opts)).toBeLessThan(reviewSeconds(40, 0, opts));
    // A typical 40-second passage takes three or four minutes to review.
    expect(reviewSeconds(40, 2, opts)).toBeGreaterThan(150);
    expect(reviewSeconds(40, 2, opts)).toBeLessThan(300);
  });
});

describe("forecastLoad", () => {
  const passage = (p: Partial<DrillPassage>): DrillPassage => ({ start: 0, end: 40, ...p });
  const reviewDays = (load: { day: number; reviews: number }[]) => load.filter((d) => d.reviews > 0).map((d) => d.day - today);

  it("follows a passage through its reviews if they go well", () => {
    const fresh = learnedPassage(passage({}), now - 2 * 3_600_000);
    const load = forecastLoad([fresh], sessionDays(schedule(), [], now, 14), now, opts);
    expect(reviewDays(load)).toEqual([0, 1, 4, 11]);
  });

  it("brings overdue reviews to the next session, and ignores passages not yet learned", () => {
    const late = passage({ level: 3, due: at(-3, 4), last: at(-10, 9) });
    const load = forecastLoad([late, passage({})], sessionDays(schedule(), [session(0, 8)], now, 4), now, opts);
    expect(reviewDays(load)).toEqual([1]);
  });

  it("carries what a day can't fit to the next", () => {
    const due = Array.from({ length: 8 }, () => passage({ level: 5, due: at(0, 4), last: at(-30, 9) }));
    const load = forecastLoad(due, sessionDays(schedule({ minutes: 10 }), [], now, 3), now, opts);
    const total = 8 * reviewSeconds(40, 5, opts);
    expect(load[0].reviewSec).toBeCloseTo(total);
    expect(load[1].reviewSec).toBeCloseTo(total - 600);
    expect(load[2].reviewSec).toBeCloseTo(total - 1200);
  });
});

describe("holding back new passages", () => {
  const due = (day: number, n: number) =>
    Array.from({ length: n }, (): DrillPassage => ({ start: 0, end: 40, level: 2, due: at(day, 4), last: at(day - 3, 9) }));
  const later = sessionDays(schedule(), [session(0, 8)], now, 9);

  it("lets a passage start when its reviews fit", () => {
    const load = forecastLoad(due(1, 2), later, now, opts);
    expect(overfilledBy(load, 40, now, opts)).toBeUndefined();
  });

  it("holds it back when its first review would overfill tomorrow", () => {
    const load = forecastLoad(due(1, 5), later, now, opts);
    expect(overfilledBy(load, 40, now, opts)?.day).toBe(today + 1);
  });

  it("looks a week ahead and no further", () => {
    // The new passage's third review lands four days on; its fourth, 11 days on, is out of range.
    expect(overfilledBy(forecastLoad(due(4, 5), later, now, opts), 40, now, opts)?.day).toBe(today + 4);
    const far = sessionDays(schedule(), [session(0, 8)], now, 14);
    expect(overfilledBy(forecastLoad(due(11, 6), far, now, opts), 40, now, opts)).toBeUndefined();
  });

  it("books a passage that starts, so the next one sees its reviews", () => {
    const load = forecastLoad(due(1, 4), later, now, opts);
    expect(overfilledBy(load, 40, now, opts)).toBeUndefined();
    bookNewPassage(load, 40, now, opts);
    expect(load[0].reviews).toBe(5);
    expect(overfilledBy(load, 40, now, opts)?.day).toBe(today + 1);
  });
});

describe("spreadReviews", () => {
  const busy = (day: number, n: number): DrillPassage[] =>
    Array.from({ length: n }, () => ({ start: 0, end: 40, level: 4, due: at(day, 4), last: at(day - 15, 9) }));

  it("keeps a review on its planned day while that day has room", () => {
    const booked = bookedByDay(busy(30, 1), schedule(), now, opts);
    const choose = spreadReviews(booked, schedule(), 40, opts);
    expect(choose([today + 29, today + 30, today + 31], today + 30, 5)).toBe(today + 30);
  });

  it("moves it to the lightest nearby day when the planned one is busy", () => {
    const booked = bookedByDay([...busy(30, 3), ...busy(29, 1)], schedule(), now, opts);
    const choose = spreadReviews(booked, schedule(), 40, opts);
    expect(choose([today + 29, today + 30, today + 31], today + 30, 5)).toBe(today + 31);
  });

  it("weighs the days of a language drilled every few days by their sessions", () => {
    const alternate = schedule({ everyDays: 2, anchorDay: today });
    // Day 30 is a session day; days 29 and 31 fall to the sessions on days 30 and 32.
    const booked = bookedByDay(busy(30, 3), alternate, now, opts);
    const choose = spreadReviews(booked, alternate, 40, opts);
    expect(choose([today + 29, today + 30, today + 31], today + 30, 5)).toBe(today + 31);
  });
});
