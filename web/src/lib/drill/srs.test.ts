import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  NEXT_SESSION_MS,
  dayNumber,
  dayStart,
  dueAfter,
  isDue,
  learnedPassage,
  overdueRatio,
  reviewPasses,
  reviewedPassage,
} from "./srs";

// 2026-03-10 18:00 local time: a Tuesday evening, away from any clock change.
const evening = new Date(2026, 2, 10, 18).getTime();
const at = (day: number, hour: number) => new Date(2026, 2, 10 + day, hour).getTime();

describe("review days", () => {
  it("start at 4am local time", () => {
    const day = dayNumber(evening);
    expect(dayStart(day)).toBe(new Date(2026, 2, 10, 4).getTime());
    expect(dayNumber(at(1, 2))).toBe(day); // 2am the next night still counts as the same day
    expect(dayNumber(at(1, 5))).toBe(day + 1);
  });
  it("survive a clock change", () => {
    const beforeUkChange = new Date(2026, 2, 28, 12).getTime();
    const d = dayNumber(beforeUkChange);
    expect(dayStart(d + 1)).toBe(new Date(2026, 2, 29, 4).getTime());
    expect(dayNumber(dayStart(d + 1))).toBe(d + 1);
  });
});

describe("dueAfter", () => {
  it("brings a level 0 passage back at the next session", () => {
    expect(dueAfter(0, evening)).toBe(evening + NEXT_SESSION_MS);
  });
  it("counts whole days from the start of the review day", () => {
    expect(dueAfter(1, evening)).toBe(new Date(2026, 2, 11, 4).getTime());
    expect(dueAfter(2, evening)).toBe(new Date(2026, 2, 13, 4).getTime());
    expect(dueAfter(3, evening)).toBe(new Date(2026, 2, 17, 4).getTime());
  });
});

describe("reviewedPassage", () => {
  const base = { start: 0, end: 40 };

  it("climbs a level at a time when reviews are on schedule", () => {
    let p = learnedPassage(base, at(0, 8));
    expect(p.level).toBe(0);
    expect(isDue(p, at(0, 8) + 30 * 60_000)).toBe(false);
    expect(isDue(p, at(0, 18))).toBe(true);
    p = reviewedPassage(p, true, at(0, 18)); // same day, evening session
    expect(p.level).toBe(1);
    p = reviewedPassage(p, true, at(1, 8));
    expect(p.level).toBe(2);
    p = reviewedPassage(p, true, at(4, 8));
    expect(p.level).toBe(3);
    expect(p.reviews).toBe(3);
  });

  it("drops a level on a fail and counts the lapse", () => {
    const p = reviewedPassage({ ...base, level: 3, last: at(-7, 8), due: at(0, 4) }, false, at(0, 8));
    expect(p.level).toBe(2);
    expect(p.lapses).toBe(1);
    expect(p.due).toBe(dueAfter(2, at(0, 8)));
  });

  it("never drops below level 0", () => {
    expect(reviewedPassage({ ...base, level: 0, last: at(0, 8) }, false, at(0, 18)).level).toBe(0);
  });

  it("jumps to the level matching a longer gap that was survived", () => {
    // Due a day after its last review but reviewed ten days later, and still passed.
    const p = reviewedPassage({ ...base, level: 1, last: at(0, 8), due: at(1, 4) }, true, at(10, 8));
    expect(p.level).toBe(4); // 7 days <= 10, so it lands on the 15-day level
  });
});

describe("reviewPasses", () => {
  it("allows one miss in a passage of four phrases or more", () => {
    expect(reviewPasses(0, 6)).toBe(true);
    expect(reviewPasses(1, 6)).toBe(true);
    expect(reviewPasses(2, 6)).toBe(false);
    expect(reviewPasses(1, 3)).toBe(false);
  });
});

describe("overdueRatio", () => {
  it("ranks a short-interval passage that is late above a long-interval one equally late", () => {
    const now = at(10, 8);
    const young = { start: 0, end: 1, level: 1, due: now - 2 * DAY_MS };
    const old = { start: 0, end: 1, level: 5, due: now - 2 * DAY_MS };
    expect(overdueRatio(young, now)).toBeGreaterThan(overdueRatio(old, now));
  });
});
