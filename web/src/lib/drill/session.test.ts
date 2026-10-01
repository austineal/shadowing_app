import { describe, expect, it } from "vitest";
import {
  DrillSession,
  blockAnnouncement,
  blockUnits,
  sessionEnglish,
  type Current,
  type LearnBlock,
  type Miss,
  type ReviewBlock,
  type SessionEvent,
} from "./session";
import { ANNOUNCE, drillOptions, type SessionPhrase } from "./steps";

const opts = drillOptions("full", { paddingMs: 120, gapFactor: 1.3, slowRate: 0.75 });
const phrase = (i: number, english = true): SessionPhrase => ({
  start: i * 8,
  end: i * 8 + 7,
  text: `p${i}`,
  english: english ? `e${i}` : undefined,
});
const phrases = (n: number) => Array.from({ length: n }, (_, i) => phrase(i));

const review = (patch: Partial<ReviewBlock> = {}): ReviewBlock => ({
  kind: "review",
  drillId: "d",
  episodeId: "ep",
  title: "t",
  passage: 1,
  passageCount: 3,
  phrases: phrases(6),
  level: 1, // phrase-by-phrase cues (see "growing cues" below)
  leadIn: phrase(-1),
  ...patch,
});

const learn = (patch: Partial<LearnBlock> = {}): LearnBlock => ({
  kind: "learn",
  drillId: "d",
  episodeId: "ep",
  title: "t",
  passage: 0,
  passageCount: 3,
  phrases: phrases(3),
  from: 0,
  to: 3,
  wrapUp: true,
  leadIn: phrase(-1),
  ...patch,
});

/** Runs a session to the end, pressing Missed whenever `miss` says so. Returns "unit:cue" per step played. */
function run(session: DrillSession, miss: (cur: Current) => boolean = () => false): string[] {
  const log: string[] = [];
  for (let guard = 0; !session.finished && guard < 5000; guard++) {
    const cur = session.current()!;
    if (miss(cur) && session.missed()?.jumped) continue; // jumped to the answer or a fix-up
    log.push(`${cur.unit.kind}:${cur.step.cue}`);
    session.advance();
  }
  return log;
}

function start(blocks: (ReviewBlock | LearnBlock)[]) {
  const events: SessionEvent[] = [];
  const session = new DrillSession(blocks, opts, (e) => events.push(e));
  return { session, events };
}

/** Miss the test of phrase `i` on its first (graded) attempt, while its speaking pause runs. */
const missFirstTry = (i: number) => (cur: Current) =>
  cur.unit.kind === "test" && cur.unit.test?.phrases.join() === String(i) && cur.step.cue === "speak";

describe("DrillSession: review", () => {
  it("announces the passage, plays a lead-in, tests each phrase from its English, then announces the shadowing", () => {
    const { session, events } = start([review({ phrases: phrases(2) })]);
    expect(run(session)).toEqual([
      ...["announce:announce", "announce:announce"],
      ...["lead-in:lead-in", "lead-in:lead-in"],
      ...["test:english", "test:speak", "test:answer", "test:answer"],
      ...["test:english", "test:speak", "test:answer", "test:answer"],
      ...["announce:announce", "announce:announce"],
      ...["shadow:shadow", "shadow:shadow"],
    ]);
    expect(events).toEqual([expect.objectContaining({ kind: "reviewed", misses: 0, passed: true })]);
  });

  it("jumps to the answer on a miss, then fixes the phrase with repeats and a retry", () => {
    const { session, events } = start([review()]);
    const log = run(session, missFirstTry(2));
    const fixup = log.filter((s) => s.startsWith("fixup:"));
    expect(fixup).toEqual([
      ...["fixup:listen", "fixup:repeat", "fixup:listen", "fixup:repeat", "fixup:listen", "fixup:repeat"],
      ...["fixup:english", "fixup:speak", "fixup:answer", "fixup:answer"],
    ]);
    // The missed test skipped its speaking pause.
    expect(log.filter((s) => s === "test:speak")).toHaveLength(5);
    expect(events).toEqual([expect.objectContaining({ kind: "reviewed", misses: 1, passed: true })]);
  });

  it("fails the passage with two missed phrases", () => {
    const { session, events } = start([review()]);
    run(session, (cur) => missFirstTry(1)(cur) || missFirstTry(4)(cur));
    expect(events).toEqual([expect.objectContaining({ misses: 2, passed: false })]);
  });

  it("gives at most two fix-ups, and retries don't count as further misses", () => {
    const { session, events } = start([review()]);
    const log = run(session, (cur) => cur.unit.test?.phrases.join() === "0" && cur.step.cue === "speak");
    const fixupAnswers = log.filter((s) => s === "fixup:answer").length / 2;
    expect(fixupAnswers).toBe(2);
    expect(events).toEqual([expect.objectContaining({ misses: 1, passed: true })]);
  });

  it("counts a miss pressed during the answer without skipping anything", () => {
    const { session, events } = start([review({ phrases: phrases(4) })]);
    run(session, (cur) => cur.unit.kind === "test" && cur.unit.test?.phrases.join() === "3" && cur.step.cue === "answer");
    expect(events).toEqual([expect.objectContaining({ misses: 1 })]);
  });

  it("just plays a phrase without English, and doesn't count it", () => {
    const ps = [phrase(0), phrase(1, false), phrase(2), phrase(3), phrase(4)];
    const { session, events } = start([review({ phrases: ps, leadIn: undefined })]);
    const log = run(session, missFirstTry(0)).filter((s) => !s.startsWith("announce"));
    expect(log.slice(0, 1)).toEqual(["test:english"]);
    expect(log).toContain("listen:listen");
    // One miss among four tested phrases still passes.
    expect(events).toEqual([expect.objectContaining({ misses: 1, passed: true })]);
  });

  it("only accepts Missed during tests", () => {
    const { session } = start([review()]);
    for (const kind of ["announce", "lead-in"]) {
      while (session.current()!.unit.kind !== kind) session.advance();
      expect(session.canMiss()).toBe(false);
      expect(session.missed()).toBeNull();
    }
  });
});

describe("DrillSession: growing cues", () => {
  /** Phrases 4 seconds long, 0.5 seconds apart; a "." ends a sentence. */
  const spoken = (...texts: string[]): SessionPhrase[] =>
    texts.map((text, i) => ({ start: i * 4.5, end: i * 4.5 + 4, text, english: `e${i}` }));
  const testsOf = (session: DrillSession) => {
    const tests: string[] = [];
    let last: Current["unit"] | undefined;
    for (let guard = 0; !session.finished && guard < 5000; guard++) {
      const cur = session.current()!;
      if (cur.unit !== last && cur.unit.kind === "test") tests.push(cur.unit.test!.phrases.join("+"));
      last = cur.unit;
      session.advance();
    }
    return tests;
  };

  it("cues a young passage phrase by phrase, and whole sentences from level 2", () => {
    const ps = spoken("a", "b.", "c", "d", "e.", "f.");
    expect(testsOf(start([review({ phrases: ps, level: 1 })]).session)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(testsOf(start([review({ phrases: ps, level: 2 })]).session)).toEqual(["0+1", "2+3+4", "5"]);
  });

  it("cues runs of sentences from level 4", () => {
    const ps = spoken("a", "b.", "c", "d", "e.", "f.");
    // Sentences stay whole: the second run takes the rest, as it fits in 20 seconds.
    expect(testsOf(start([review({ phrases: ps, level: 4 })]).session)).toEqual(["0+1", "2+3+4+5"]);
  });

  it("shows a sentence's answer a phrase at a time", () => {
    const { session } = start([review({ phrases: spoken("a", "b."), level: 2, leadIn: undefined })]);
    while (session.current()!.step.cue !== "answer") session.advance();
    expect(session.current()!.step.phrases?.map((p) => p.text)).toEqual(["a", "b."]);
  });

  it("fixes a missed sentence a phrase at a time, then retries it whole", () => {
    const { session } = start([review({ phrases: spoken("a", "b.", "c."), level: 2, leadIn: undefined })]);
    const log = run(session, (cur) => cur.unit.kind === "test" && cur.unit.test?.phrases.join() === "0,1" && cur.step.cue === "speak");
    expect(log.filter((s) => s.startsWith("fixup:"))).toEqual([
      ...["fixup:listen", "fixup:repeat", "fixup:listen", "fixup:repeat"],
      ...["fixup:english", "fixup:english", "fixup:english", "fixup:speak", "fixup:answer", "fixup:answer"],
    ]);
  });

  it("counts misses by cue, and needs four cues to forgive one", () => {
    const ps = spoken("a", "b.", "c", "d.", "e", "f.", "g", "h.");
    const missSentence = (first: number) => (cur: Current) =>
      cur.unit.kind === "test" && cur.unit.test?.phrases[0] === first && cur.unit.test.graded && cur.step.cue === "speak";
    // Four sentences: one missed passes.
    let s = start([review({ phrases: ps, level: 2 })]);
    expect(testsOf(start([review({ phrases: ps, level: 2 })]).session)).toEqual(["0+1", "2+3", "4+5", "6+7"]);
    run(s.session, missSentence(0));
    expect(s.events).toEqual([expect.objectContaining({ misses: 1, passed: true })]);
    // Two runs of sentences: one missed fails.
    s = start([review({ phrases: ps, level: 4 })]);
    run(s.session, missSentence(0));
    expect(s.events).toEqual([expect.objectContaining({ misses: 1, passed: false })]);
  });
});

describe("DrillSession: announcements", () => {
  const said = (units: { kind: string; steps: { play: { kind: string } & Partial<{ text: string }> }[] }[]) =>
    units.filter((u) => u.kind === "announce").map((u) => u.steps[0].play.text);

  it("opens each block by saying what it is", () => {
    expect(blockAnnouncement(review({ passageTitle: "Arriving in Tehran" }))).toBe("Review: Arriving in Tehran.");
    expect(blockAnnouncement(review())).toBe("Review.");
    expect(blockAnnouncement(learn({ passageTitle: "The prison" }))).toBe("New passage: The prison.");
    expect(blockAnnouncement(learn({ passageTitle: "The prison", from: 2 }))).toBe("Continuing: The prison.");
    expect(blockAnnouncement(learn({ from: 2 }))).toBe("Continuing the passage.");
  });

  it("announces the run-through and the shadowing, after the passage's own announcement", () => {
    expect(said(blockUnits(learn(), opts))).toEqual(["New passage.", ANNOUNCE.wrapUp, ANNOUNCE.shadow]);
    expect(said(blockUnits(review(), opts))).toEqual(["Review.", ANNOUNCE.shadow]);
    // Nothing to run through without English: straight to the shadowing.
    const unheard = phrases(2).map((p) => ({ ...p, english: undefined }));
    expect(said(blockUnits(learn({ phrases: unheard, to: 2 }), opts))).toEqual(["New passage.", ANNOUNCE.shadow]);
  });

  it("shows an announcement's words on screen", () => {
    const { session } = start([review({ passageTitle: "Arriving in Tehran" })]);
    expect(session.current()!.step).toMatchObject({ cue: "announce", label: "Review: Arriving in Tehran" });
  });

  it("takes a Missed pressed during the shadowing announcement as late, for the last test", () => {
    const { session } = start([review({ phrases: phrases(2), leadIn: undefined })]);
    while (!(session.current()!.unit.kind === "announce" && session.current()!.unitIndex > 0)) session.advance();
    const miss = session.missed();
    expect(miss).toMatchObject({ late: true, jumped: true });
    expect(miss!.phrases.map((p) => p.text)).toEqual(["p1"]);
  });

  it("lists the English a session speaks, with the announcements and its closing words", () => {
    const texts = sessionEnglish([review({ phrases: phrases(2), passageTitle: "Arrival" })], opts);
    expect(texts).toEqual(expect.arrayContaining(["Review: Arrival.", "e0", "e1", ANNOUNCE.shadow, ANNOUNCE.end]));
    expect(sessionEnglish([], opts)).toEqual([]);
  });
});

describe("DrillSession: late Missed presses", () => {
  /** Plays to the end, pressing Missed once where `at` says; returns what the press did and each unit as it started. */
  function playWithPress(session: DrillSession, at: (cur: Current) => boolean) {
    const units: string[] = [];
    let last: Current["unit"] | undefined;
    let miss: Miss | null | undefined;
    for (let guard = 0; !session.finished && guard < 5000; guard++) {
      const cur = session.current()!;
      if (cur.unit !== last) units.push(`${cur.unit.kind} ${cur.unit.test?.phrases.join("+") ?? ""}`.trim());
      last = cur.unit;
      if (miss === undefined && at(cur)) {
        miss = session.missed();
        if (miss?.jumped) continue;
      }
      session.advance();
    }
    return { miss, units };
  }
  const testOf = (cur: Current) => cur.unit.test?.phrases.join();

  it("gives the phrase just answered its fix-up when pressed during the next English", () => {
    const { session, events } = start([review({ leadIn: undefined, phrases: phrases(3) })]);
    const { miss, units } = playWithPress(session, (cur) => cur.unit.kind === "test" && testOf(cur) === "1" && cur.step.cue === "english");
    expect(miss).toMatchObject({ late: true, jumped: true });
    expect(miss!.phrases.map((p) => p.text)).toEqual(["p0"]);
    expect(units).toEqual(["announce", "test 0", "test 1", "fixup 0", "test 1", "test 2", "announce", "shadow"]);
    // One miss in a three-phrase passage fails it.
    expect(events).toEqual([expect.objectContaining({ misses: 1, passed: false })]);
  });

  it("takes a late press at the start of the next phrase's learning, when learning", () => {
    const { session } = start([learn({ leadIn: undefined, phrases: phrases(3) })]);
    // After phrase 0's first try, its learning is followed by phrase 1's learning, not a test.
    const { miss, units } = playWithPress(session, (cur) => cur.unit.kind === "learn" && cur.step.cue === "english" && cur.step.text === "p1");
    expect(miss).toMatchObject({ late: true, jumped: true });
    expect(miss!.phrases.map((p) => p.text)).toEqual(["p0"]);
    expect(units.slice(0, 6)).toEqual(["announce", "learn", "test 0", "learn", "fixup 0", "learn"]);
  });

  it("doesn't take a late press during the whole-passage run-through", () => {
    const { session } = start([review({ leadIn: undefined, phrases: phrases(2) })]);
    while (session.current()!.unit.kind !== "shadow") session.advance();
    expect(session.canMiss()).toBe(false);
    expect(session.missed()).toBeNull();
  });

  it("counts a press during the speaking pause for the phrase being tested", () => {
    const { session } = start([review({ leadIn: undefined })]);
    const { miss, units } = playWithPress(session, (cur) => cur.unit.kind === "test" && testOf(cur) === "1" && cur.step.cue === "speak");
    expect(miss).toMatchObject({ late: false, jumped: true });
    expect(miss!.phrases.map((p) => p.text)).toEqual(["p1"]);
    expect(units.slice(0, 4)).toEqual(["announce", "test 0", "test 1", "fixup 1"]);
  });

  it("has nothing to be late for on the first test after a lead-in", () => {
    const { session } = start([review()]);
    const { miss } = playWithPress(session, (cur) => cur.unit.kind === "test" && cur.step.cue === "english");
    expect(miss).toMatchObject({ late: false, jumped: true });
    expect(miss!.phrases.map((p) => p.text)).toEqual(["p0"]);
  });

  it("counts a late press after a fix-up's retest for that retest, still once for the passage", () => {
    const { session, events } = start([review({ leadIn: undefined })]);
    let missedFirst = false;
    const { units } = playWithPress(session, (cur) => {
      if (!missedFirst && cur.unit.kind === "test" && testOf(cur) === "0" && cur.step.cue === "speak") {
        missedFirst = true;
        session.missed(); // missed in time: jumps to the answer, and the fix-up follows
        return false;
      }
      return cur.unit.kind === "test" && testOf(cur) === "1" && cur.step.cue === "english";
    });
    // The press during test 1's English was about the fix-up's retest, so phrase 0 gets another round.
    expect(units.slice(0, 6)).toEqual(["announce", "test 0", "fixup 0", "test 1", "fixup 0", "test 1"]);
    expect(events).toEqual([expect.objectContaining({ misses: 1, passed: true })]);
  });
});

describe("DrillSession: learning", () => {
  it("learns each phrase, joins it to the one before, then wraps up the passage", () => {
    const { session, events } = start([learn()]);
    const units: string[] = [];
    let last: Current["unit"] | undefined;
    for (let guard = 0; !session.finished && guard < 5000; guard++) {
      const cur = session.current()!;
      if (cur.unit !== last) units.push(cur.unit.test ? `test ${cur.unit.test.phrases.join("+")}` : cur.unit.kind);
      last = cur.unit;
      session.advance();
    }
    expect(units).toEqual([
      ...["announce", "lead-in"],
      ...["learn", "test 0"],
      ...["learn", "test 1", "test 0+1"],
      ...["learn", "test 2", "test 1+2"],
      ...["announce", "test 0", "test 1", "test 2"],
      ...["announce", "shadow"],
    ]);
    expect(events.map((e) => (e.kind === "learning" ? `learning ${e.phrases}` : e.kind))).toEqual([
      "learning 1",
      "learning 2",
      "learning 3",
      "learned",
    ]);
  });

  it("starts with the full slowed repeats and the English", () => {
    const { session } = start([learn({ leadIn: undefined })]);
    while (session.current()!.unit.kind === "announce") session.advance();
    const first = session.current()!;
    expect(first.step.cue).toBe("english");
    session.advance();
    session.advance();
    const listen = session.current()!.step.play;
    expect(listen).toMatchObject({ kind: "source", rate: 0.75 });
  });

  it("resumes partway through a passage, led in by the last phrase learned", () => {
    const { session, events } = start([learn({ phrases: phrases(5), from: 3, to: 5, wrapUp: false })]);
    while (session.current()!.unit.kind === "announce") session.advance();
    const cur = session.current()!;
    expect(cur.unit.kind).toBe("lead-in");
    expect(cur.step.text).toBe("p2");
    run(session);
    expect(events.map((e) => (e.kind === "learning" ? e.phrases : e.kind))).toEqual([4, 5]);
  });

  it("runs blocks one after another", () => {
    const { session, events } = start([review({ phrases: phrases(2) }), learn({ phrases: phrases(1), to: 1 })]);
    run(session);
    expect(session.finished).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(["reviewed", "learning", "learned"]);
  });
});
