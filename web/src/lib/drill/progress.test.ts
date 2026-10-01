import { describe, expect, it } from "vitest";
import { formatProgress, passageStage, progressOf, transcriptMarks } from "./progress";
import type { Drill, DrillPassage } from "../../types";

const now = new Date(2026, 4, 10, 9).getTime();
const DAY = 86_400_000;

/** An excerpt of 20-second passages from 100 s into an episode. */
function drill(passages: Partial<DrillPassage>[], patch: Partial<Drill> = {}): Drill {
  return {
    id: "d",
    episodeId: "ep",
    episodeTitle: "Episode",
    language: "fr",
    start: 100,
    end: 100 + passages.length * 20,
    createdAt: 0,
    learning: null,
    passages: passages.map((p, i) => ({ start: 100 + i * 20, end: 100 + (i + 1) * 20, ...p })),
    ...patch,
  };
}

/** Phrases of 4.5 seconds every 5 seconds: four to a passage. */
const phrases = Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 4.5 }));

const learned = (level: number, due = now + DAY): Partial<DrillPassage> => ({ level, due, last: now - DAY });

describe("passageStage", () => {
  it("goes from new through learning to solid", () => {
    const d = drill([learned(0), learned(2), learned(5), {}, {}], { learning: { passage: 3, phrases: 2 } });
    expect(d.passages.map((_, i) => passageStage(d, i))).toEqual(["fresh", "growing", "solid", "learning", "new"]);
  });
});

describe("progressOf", () => {
  it("counts learned, solid and due passages across excerpts", () => {
    const a = drill([learned(4), learned(1, now - DAY), {}]);
    const b = drill([learned(6, now - 1)]);
    const p = progressOf([a, b], now);
    expect(p).toEqual({ passages: 4, learned: 3, solid: 2, due: 2 });
    expect(formatProgress(p)).toBe("3 of 4 learned · 2 solid · 2 due");
    expect(formatProgress(progressOf([drill([{}, {}])], now))).toBe("0 of 2 learned");
  });
});

describe("transcriptMarks", () => {
  it("marks each phrase of the excerpt with its passage and stage", () => {
    const d = drill([learned(4), learned(1, now - DAY), {}]);
    const marks = transcriptMarks(phrases, [d], now);
    expect([...marks.keys()]).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
    expect(marks.get(20)).toMatchObject({ passage: 0, stage: "solid", due: false, first: true });
    expect(marks.get(21)).toMatchObject({ passage: 0, first: false });
    expect(marks.get(24)).toMatchObject({ passage: 1, stage: "fresh", due: true, first: true });
    expect(marks.get(28)).toMatchObject({ passage: 2, stage: "new" });
  });

  it("draws the learned-up-to line after the last learned passage", () => {
    const d = drill([learned(4), learned(1), {}]);
    const marks = transcriptMarks(phrases, [d], now);
    expect([...marks].filter(([, m]) => m.learnedTo).map(([j]) => j)).toEqual([27]);
  });

  it("draws it partway through the passage being learned", () => {
    const d = drill([learned(4), {}, {}], { learning: { passage: 1, phrases: 3 } });
    const marks = transcriptMarks(phrases, [d], now);
    expect([...marks].filter(([, m]) => m.learnedTo).map(([j]) => j)).toEqual([26]);
  });

  it("draws no line before anything is learned, or once everything is", () => {
    for (const d of [drill([{}, {}]), drill([learned(1), learned(3)])]) {
      expect([...transcriptMarks(phrases, [d], now).values()].some((m) => m.learnedTo)).toBe(false);
    }
  });
});
