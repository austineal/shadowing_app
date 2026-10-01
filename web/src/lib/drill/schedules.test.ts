import { describe, expect, it } from "vitest";
import { drillScheduleKey, logScheduleKey, newScheduleKey, scheduleForEpisode, scheduleLabel, schedulesOf } from "./schedules";
import type { Drill, DrillPrefs, DrillSchedule } from "../../types";

const schedule = (patch: Partial<DrillSchedule> = {}): DrillSchedule => ({
  perDay: 1,
  everyDays: 1,
  minutes: 20,
  newMaterial: true,
  learning: "full",
  ...patch,
});
const prefs: DrillPrefs = {
  schedules: {
    ja: schedule(),
    ja_b: schedule({ language: "ja", name: "Deck" }),
    ja_a: schedule({ language: "ja", name: "News" }),
    cy: schedule(),
  },
};
const drill = (patch: Partial<Drill>): Drill =>
  ({ id: "d", episodeId: "e", episodeTitle: "", language: "ja", start: 0, end: 1, passages: [], createdAt: 0, ...patch }) as Drill;

describe("schedules", () => {
  it("lists a language's schedules, the main one first", () => {
    expect(schedulesOf(prefs, "ja")).toEqual(["ja", "ja_a", "ja_b"]);
    expect(schedulesOf(prefs, "cy")).toEqual(["cy"]);
    expect(schedulesOf(prefs, "fr")).toEqual([]);
  });

  it("puts drills and logs without a schedule, or with a removed one, on the main one", () => {
    expect(drillScheduleKey(drill({}), prefs)).toBe("ja");
    expect(drillScheduleKey(drill({ schedule: "ja_a" }), prefs)).toBe("ja_a");
    expect(drillScheduleKey(drill({ schedule: "ja_gone" }), prefs)).toBe("ja");
    expect(logScheduleKey({ language: "ja", schedule: "ja_b" }, prefs)).toBe("ja_b");
    expect(logScheduleKey({ language: "cy" }, prefs)).toBe("cy");
  });

  it("labels named schedules", () => {
    expect(scheduleLabel("ja_a", prefs.schedules.ja_a)).toBe("Japanese · News");
    expect(scheduleLabel("cy", prefs.schedules.cy)).toBe("Welsh");
  });

  it("suggests the schedule of the episode's latest excerpt", () => {
    const existing = [drill({ createdAt: 1, schedule: "ja_a" }), drill({ createdAt: 2, schedule: "ja_b" })];
    expect(scheduleForEpisode(prefs, "ja", existing)).toBe("ja_b");
    expect(scheduleForEpisode(prefs, "ja", [])).toBe("ja");
  });

  it("makes keys that sort in the order they were made", () => {
    const a = newScheduleKey("ja", Date.UTC(2026, 9, 1));
    const b = newScheduleKey("ja", Date.UTC(2026, 9, 2));
    expect(a.startsWith("ja_")).toBe(true);
    expect([b, a].sort()).toEqual([a, b]);
  });
});
