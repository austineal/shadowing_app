import { describe, expect, it } from "vitest";
import type { SessionDay } from "./forecast";
import { learningDrill, learningSeconds, planSession, type PlanDrill } from "./plan";
import { dayNumber } from "./srs";
import { drillOptions, type SessionPhrase } from "./steps";
import type { Drill, DrillPassage } from "../../types";

const opts = drillOptions("full", { paddingMs: 120, gapFactor: 1.3, slowRate: 0.75 });
const DAY = 86_400_000;
const now = new Date(2026, 4, 10, 9).getTime();

/** An episode of 7-second phrases every 8 seconds; each 40-second passage holds five of them. */
const episode = (n: number): SessionPhrase[] =>
  Array.from({ length: n }, (_, i) => ({ start: i * 8, end: i * 8 + 7, text: `p${i}.`, english: `english ${i}` }));

function drill(id: string, passages: Partial<DrillPassage>[], patch: Partial<Drill> = {}): PlanDrill {
  return {
    drill: {
      id,
      episodeId: `ep-${id}`,
      episodeTitle: id,
      language: "ja",
      start: 0,
      end: passages.length * 40,
      createdAt: 0,
      learning: null,
      passages: passages.map((p, i) => ({ start: i * 40, end: (i + 1) * 40, ...p })),
      ...patch,
    },
    phrases: episode(passages.length * 5),
  };
}

const dueBy = (days: number, level = 2): Partial<DrillPassage> => ({ level, due: now - days * DAY, last: now - 5 * DAY });
const notDue: Partial<DrillPassage> = { level: 3, due: now + 3 * DAY, last: now - 4 * DAY };

describe("planSession: reviews", () => {
  it("reviews due passages in story order, with a lead-in only where the story jumps", () => {
    const d = drill("a", [notDue, dueBy(1), dueBy(3), notDue, dueBy(2)]);
    const plan = planSession({ now, budgetSec: 3600, newMaterial: false, opts, drills: [d] });
    expect(plan.blocks.map((b) => `${b.kind} ${b.passage} ${b.leadIn ? "lead-in" : "joined"}`)).toEqual([
      "review 1 lead-in",
      "review 2 joined",
      "review 4 lead-in",
    ]);
    expect(plan.due).toBe(3);
    expect(plan.deferred).toBe(0);
  });

  it("fills the budget with the most overdue passages and leaves the rest", () => {
    const d = drill("a", [dueBy(1), dueBy(9), dueBy(2), dueBy(8)]);
    const plan = planSession({ now, budgetSec: 400, newMaterial: true, opts, drills: [d] });
    expect(plan.blocks.map((b) => b.passage)).toEqual([1, 3]);
    expect(plan.deferred).toBe(2);
    // Nothing new while reviews are waiting.
    expect(plan.blocks.every((b) => b.kind === "review")).toBe(true);
  });

  it("groups passages by excerpt, most urgent excerpt first", () => {
    const a = drill("a", [dueBy(1), dueBy(1)]);
    const b = drill("b", [dueBy(10)]);
    const plan = planSession({ now, budgetSec: 3600, newMaterial: false, opts, drills: [a, b] });
    expect(plan.blocks.map((x) => `${x.drillId}${x.passage}`)).toEqual(["b0", "a0", "a1"]);
  });
});

describe("planSession: learning", () => {
  it("learns new passages after the reviews, stopping partway when time runs out", () => {
    const d = drill("a", [{ level: 1, due: now - DAY, last: now - 2 * DAY }, {}, {}, {}]);
    const plan = planSession({ now, budgetSec: 30 * 60, newMaterial: true, opts, drills: [d] });
    const [first, ...learning] = plan.blocks;
    expect(first).toMatchObject({ kind: "review", passage: 0 });
    expect(learning[0]).toMatchObject({ kind: "learn", passage: 1, from: 0, to: 5, wrapUp: true, leadIn: undefined });
    const last = learning[learning.length - 1];
    expect(last.kind).toBe("learn");
    expect(plan.seconds).toBeLessThanOrEqual(30 * 60);
    expect(plan.seconds).toBeGreaterThan(20 * 60);
  });

  it("resumes the passage being learned where it stopped", () => {
    const d = drill("a", [{}, {}], { learning: { passage: 0, phrases: 3 } });
    const plan = planSession({ now, budgetSec: 3600, newMaterial: true, opts, drills: [d] });
    expect(plan.blocks[0]).toMatchObject({ kind: "learn", passage: 0, from: 3, to: 5, wrapUp: true });
  });

  it("can leave just the wrap-up for next time", () => {
    const d = drill("a", [{}], { learning: { passage: 0, phrases: 5 } });
    const plan = planSession({ now, budgetSec: 3600, newMaterial: true, opts, drills: [d] });
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0]).toMatchObject({ from: 5, to: 5, wrapUp: true });
  });

  it("learns nothing when new material is off", () => {
    const plan = planSession({ now, budgetSec: 3600, newMaterial: false, opts, drills: [drill("a", [{}, {}])] });
    expect(plan.blocks).toEqual([]);
  });

  it("takes new material from the excerpt under way, else the oldest", () => {
    const older = drill("older", [{}], { createdAt: 1 });
    const newer = drill("newer", [{}], { createdAt: 2 });
    expect(learningDrill([newer, older])?.drill.id).toBe("older");
    const started = drill("started", [{}], { createdAt: 3, learning: { passage: 0, phrases: 1 } });
    expect(learningDrill([newer, older, started])?.drill.id).toBe("started");
    const done = drill("done", [{ level: 2, due: now + DAY }], { createdAt: 0 });
    expect(learningDrill([done])).toBeUndefined();
  });
});

describe("planSession: holding back new material", () => {
  const today = dayNumber(now);
  /** The sessions after this one: one a day from tomorrow, 20 minutes each. */
  const upcoming: SessionDay[] = Array.from({ length: 8 }, (_, k) => ({ day: today + 1 + k, sessions: 1, capacitySec: 20 * 60 }));
  const dueTomorrow: Partial<DrillPassage> = { level: 2, due: now + DAY, last: now - 2 * DAY };
  const plan = (d: PlanDrill) => planSession({ now, budgetSec: 30 * 60, newMaterial: true, opts, drills: [d], upcoming });

  it("starts a new passage when its reviews fit in the coming week", () => {
    const p = plan(drill("a", [dueTomorrow, dueTomorrow, {}, {}]));
    expect(p.blocks[0]).toMatchObject({ kind: "learn", passage: 2, from: 0 });
    expect(p.heldBack).toBeUndefined();
  });

  it("holds new passages back when one would overfill tomorrow's session", () => {
    const p = plan(drill("a", [dueTomorrow, dueTomorrow, dueTomorrow, dueTomorrow, dueTomorrow, {}, {}]));
    expect(p.blocks).toEqual([]);
    expect(p.heldBack?.day).toBe(today + 1);
  });

  it("stops after the passages that fit, counting the ones it starts", () => {
    const p = plan(drill("a", [dueTomorrow, dueTomorrow, dueTomorrow, dueTomorrow, {}, {}, {}], { learning: null }));
    const started = p.blocks.filter((b) => b.kind === "learn" && b.from === 0);
    expect(started.map((b) => b.passage)).toEqual([4]);
    expect(p.heldBack?.day).toBe(today + 1);
  });

  it("still finishes a passage already under way", () => {
    const busy = [dueTomorrow, dueTomorrow, dueTomorrow, dueTomorrow, dueTomorrow, dueTomorrow];
    const p = plan(drill("a", [...busy, {}], { learning: { passage: 6, phrases: 2 } }));
    expect(p.blocks[0]).toMatchObject({ kind: "learn", passage: 6, from: 2 });
  });
});

describe("learningSeconds", () => {
  it("comes to roughly 15 to 30 minutes of drilling per minute of audio", () => {
    const ps = episode(15); // two minutes of audio in three passages
    const sec = learningSeconds([ps.slice(0, 5), ps.slice(5, 10), ps.slice(10)], opts);
    const perMinute = sec / 60 / 2;
    expect(perMinute).toBeGreaterThan(15);
    expect(perMinute).toBeLessThan(30);
  });
});
