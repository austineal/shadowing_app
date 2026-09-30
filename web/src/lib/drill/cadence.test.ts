import { describe, expect, it } from "vitest";
import { availability, pickAnchorDay } from "./cadence";
import { dayNumber, dayStart } from "./srs";
import type { DrillSchedule } from "../../types";

const schedule = (patch: Partial<DrillSchedule>): DrillSchedule => ({
  perDay: 1,
  everyDays: 1,
  minutes: 20,
  newMaterial: true,
  learning: "full",
  ...patch,
});
const at = (day: number, hour: number, min = 0) => new Date(2026, 4, 4 + day, hour, min).getTime();
const session = (day: number, hour: number, minutes = 30) => ({ startedAt: at(day, hour), endedAt: at(day, hour, minutes) });

describe("availability: daily", () => {
  const daily = schedule({});
  it("is due with no sessions yet", () => {
    expect(availability(daily, [], at(0, 9))).toEqual({ due: true, doneToday: 0 });
  });
  it("is done for the day after one session, and due again tomorrow", () => {
    const sessions = [session(0, 9)];
    expect(availability(daily, sessions, at(0, 20))).toEqual({ due: false, next: dayStart(dayNumber(at(1, 9))), doneToday: 1 });
    expect(availability(daily, sessions, at(1, 7)).due).toBe(true);
  });
});

describe("availability: twice a day", () => {
  const twice = schedule({ perDay: 2 });
  it("waits a few hours between the two sessions", () => {
    const sessions = [session(0, 8)];
    const a = availability(twice, sessions, at(0, 10));
    expect(a.due).toBe(false);
    expect(a.next).toBe(at(0, 13, 30));
    expect(availability(twice, sessions, at(0, 14)).due).toBe(true);
  });
  it("is done after the second session", () => {
    expect(availability(twice, [session(0, 8), session(0, 18)], at(0, 23)).due).toBe(false);
  });
});

describe("availability: every other day", () => {
  const today = dayNumber(at(0, 12));
  const alternate = schedule({ everyDays: 2, anchorDay: today });
  it("is due on its days and not in between", () => {
    expect(availability(alternate, [], at(0, 12)).due).toBe(true);
    const sessions = [session(0, 12)];
    expect(availability(alternate, sessions, at(1, 12))).toMatchObject({ due: false, next: dayStart(today + 2) });
    expect(availability(alternate, sessions, at(2, 12)).due).toBe(true);
  });
  it("stays due when its day is missed", () => {
    expect(availability(alternate, [session(0, 12)], at(3, 12)).due).toBe(true);
  });
  it("doesn't come up before its first turn", () => {
    const tomorrowFirst = schedule({ everyDays: 2, anchorDay: today + 1 });
    expect(availability(tomorrowFirst, [], at(0, 12))).toMatchObject({ due: false, next: dayStart(today + 1) });
    expect(availability(tomorrowFirst, [], at(1, 12)).due).toBe(true);
  });
  it("keeps its turn after a late session", () => {
    // Day 2 was missed and done on day 3 instead; the next turn is still day 4.
    const sessions = [session(0, 12), session(3, 12)];
    expect(availability(alternate, sessions, at(3, 20))).toMatchObject({ due: false, next: dayStart(today + 4) });
  });
});

describe("pickAnchorDay", () => {
  it("gives a second every-other-day language the other day", () => {
    const today = 20_000;
    const french = schedule({ everyDays: 2, anchorDay: today });
    expect(pickAnchorDay([french], 2, today)).toBe(today + 1);
    expect(pickAnchorDay([], 2, today)).toBe(today);
  });
  it("ignores languages on other rhythms", () => {
    const today = 20_000;
    expect(pickAnchorDay([schedule({ everyDays: 3, anchorDay: today })], 2, today)).toBe(today);
  });
});
