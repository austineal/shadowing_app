import { describe, expect, it } from "vitest";
import { reviewSeconds } from "./forecast";
import { CARD_BATCH, frontier, planSession, type PlanDrill } from "./plan";
import { DrillSession, blockUnits, type Block, type SessionEvent } from "./session";
import { drillOptions, testSteps, type SessionPhrase } from "./steps";
import type { Drill, DrillPassage } from "../../types";

const opts = drillOptions("full", { paddingMs: 120, gapFactor: 1.3 });
const DAY = 86_400_000;
const now = new Date(2026, 4, 10, 9).getTime();

/** A deck of 3-second cards every 10 seconds, each with its English recorded a second after it. */
const cardPhrases = (n: number): SessionPhrase[] =>
  Array.from({ length: n }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 3,
    text: `card ${i}。`,
    english: `english ${i}`,
    englishAt: { start: i * 10 + 4, end: i * 10 + 7 },
  }));

function deck(id: string, passages: Partial<DrillPassage>[], patch: Partial<Drill> = {}): PlanDrill {
  return {
    drill: {
      id,
      kind: "cards",
      episodeId: `ep-${id}`,
      episodeTitle: id,
      language: "ja",
      start: 0,
      end: passages.length * 10,
      createdAt: 0,
      learning: null,
      lessons: ["Level 1", "Level 2", "Level 3"],
      passages: passages.map((p, i) => ({ start: i * 10, end: i * 10 + 8, card: true, ...p })),
      ...patch,
    },
    phrases: cardPhrases(passages.length),
  };
}

const due: Partial<DrillPassage> = { level: 2, due: now - DAY, last: now - 4 * DAY };
const fresh = (lesson = 0): Partial<DrillPassage> => ({ lesson });
/** Not random: keeps the order, so tests can predict it. */
const keep = () => 0.999;

describe("planSession: decks", () => {
  it("reviews due cards in rounds of at most ten, with no lead-in", () => {
    const d = deck("a", Array.from({ length: 23 }, () => due));
    const plan = planSession({ now, budgetSec: 3600, newMaterial: false, opts, drills: [d], random: keep });
    expect(plan.blocks.map((b) => b.cards?.length)).toEqual([10, 10, 3]);
    expect(plan.blocks.every((b) => b.kind === "review" && !b.leadIn)).toBe(true);
    expect(new Set(plan.blocks.flatMap((b) => b.cards)).size).toBe(23);
  });

  it("learns new cards a batch at a time, in the deck's order", () => {
    const d = deck("a", Array.from({ length: 12 }, () => fresh()));
    const plan = planSession({ now, budgetSec: 3600, newMaterial: true, opts, drills: [d], random: keep });
    expect(plan.blocks.map((b) => b.cards)).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6, 7, 8, 9],
      [10, 11],
    ]);
    expect(plan.blocks.every((b) => b.kind === "learn" && b.wrapUp && b.from === 0 && b.to === b.cards!.length)).toBe(true);
    expect(CARD_BATCH).toBe(5);
  });

  it("only learns from lessons up to the limit", () => {
    const d = deck("a", [{ ...due, lesson: 0 }, fresh(0), fresh(1), fresh(1), fresh(2)], { lessonLimit: 1 });
    const plan = planSession({ now, budgetSec: 3600, newMaterial: true, opts, drills: [d], random: keep });
    expect(plan.blocks.filter((b) => b.kind === "learn").flatMap((b) => b.cards)).toEqual([1, 2, 3]);
    expect(plan.blocks.find((b) => b.kind === "learn")?.passageTitle).toBe("Level 1");
    expect(frontier({ ...d.drill, passages: d.drill.passages.map((p) => ({ ...p, level: p.lesson! < 2 ? 0 : undefined })) })).toBe(-1);
  });

  it("shares the time for new material with an excerpt", () => {
    const d = deck("deck", Array.from({ length: 200 }, () => fresh()));
    const excerpt: PlanDrill = {
      drill: {
        id: "ex",
        episodeId: "ep-ex",
        episodeTitle: "ex",
        language: "ja",
        start: 0,
        end: 400,
        createdAt: 0,
        learning: null,
        passages: Array.from({ length: 10 }, (_, i) => ({ start: i * 40, end: (i + 1) * 40 })),
      },
      phrases: Array.from({ length: 50 }, (_, i) => ({ start: i * 8, end: i * 8 + 7, text: `p${i}.`, english: `english ${i}` })),
    };
    const plan = planSession({ now, budgetSec: 1200, newMaterial: true, opts, drills: [excerpt, d], random: keep });
    const cards = plan.blocks.filter((b) => b.cards);
    const passages = plan.blocks.filter((b) => !b.cards);
    expect(cards.length).toBeGreaterThan(0);
    expect(passages.length).toBeGreaterThan(0);
    // The excerpt's blocks come first, then the deck's.
    expect(plan.blocks.findIndex((b) => b.cards)).toBe(passages.length);
    expect(plan.seconds).toBeLessThanOrEqual(1200);
  });
});

describe("DrillSession: cards", () => {
  const phrases = cardPhrases(3);
  const base = { drillId: "d", episodeId: "ep", title: "Deck", passage: 4, passageCount: 9, phrases, cards: [4, 7, 8], order: [2, 0, 1] };

  it("tests each card of a review round in its shuffled order, without shadowing", () => {
    const block: Block = { kind: "review", level: 1, ...base };
    const units = blockUnits(block, opts);
    expect(units.map((u) => u.kind)).toEqual(["announce", "test", "test", "test"]);
    expect(units.slice(1).map((u) => u.test!.phrases)).toEqual([[2], [0], [1]]);
    expect(units[0].steps[0].play).toEqual({ kind: "announce", text: "Review: 3 cards." });
  });

  it("reports which cards were missed", () => {
    const events: SessionEvent[] = [];
    const session = new DrillSession([{ kind: "review", level: 1, ...base }], opts, (e) => events.push(e));
    // Through the announcement, then miss the first test (card index 2).
    while (session.current()!.unit.kind === "announce") session.advance();
    session.missed();
    while (!session.finished) session.advance();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "reviewed", misses: 1, missed: [2] });
  });

  it("learns cards one by one without joining them, then tests them all shuffled", () => {
    const block: Block = { kind: "learn", from: 0, to: 3, wrapUp: true, ...base };
    const units = blockUnits(block, opts);
    expect(units.map((u) => u.kind)).toEqual(["announce", "learn", "test", "learn", "test", "learn", "test", "announce", "test", "test", "test"]);
    expect(units.slice(-3).map((u) => u.test!.phrases)).toEqual([[2], [0], [1]]);
    expect(units.every((u) => u.learned === undefined)).toBe(true);

    const events: SessionEvent[] = [];
    const session = new DrillSession([block], opts, (e) => events.push(e));
    while (!session.finished) session.advance();
    expect(events.map((e) => e.kind)).toEqual(["learned"]);
  });

  it("cues with the recorded English", () => {
    const steps = testSteps("ep", [phrases[1]], 1, opts);
    expect(steps[0].play).toEqual({ kind: "source", episodeId: "ep", start: 14, end: 17, rate: 1 });
    expect(steps[0].english).toBe("english 1");
  });
});

describe("reviewSeconds: cards", () => {
  it("costs a card much less than a passage of the same length", () => {
    expect(reviewSeconds(3, 2, opts, true)).toBeLessThan(reviewSeconds(3, 2, opts) * 0.7);
  });
});
