/**
 * A drill session: a list of blocks (passages to review or learn) played as a sequence of units,
 * each a short run of steps. The session reacts to Missed presses by jumping to the answer and
 * adding a fix-up, and reports each passage's result as it finishes. It holds no audio; the
 * player asks it for the current step and tells it when that step is over.
 */
import { reviewPasses } from "./srs";
import {
  ANNOUNCE,
  announceSteps,
  cueGroups,
  cueSize,
  hasEnglish,
  leadInSteps,
  learnSteps,
  repeatSteps,
  shadowSteps,
  stepsSeconds,
  testSteps,
  type DrillOptions,
  type SessionPhrase,
  type Step,
} from "./steps";

interface BlockBase {
  drillId: string;
  episodeId: string;
  /** What the screen calls the excerpt. */
  title: string;
  /** The passage's own title, when Claude planned the passages. */
  passageTitle?: string;
  /** Index of the passage in the drill, and how many passages the drill has. */
  passage: number;
  passageCount: number;
  /** All phrases of the passage, in order. */
  phrases: SessionPhrase[];
  /** The phrase before the passage, played for context first. Absent when the session has just played it. */
  leadIn?: SessionPhrase;
}

export interface ReviewBlock extends BlockBase {
  kind: "review";
  /** The passage's level, which sets how long the learner gets to answer and how much each cue covers. */
  level: number;
}

export interface LearnBlock extends BlockBase {
  kind: "learn";
  /** First phrase to learn this session; earlier ones were learned in an earlier session. */
  from: number;
  /** One past the last phrase to learn this session. */
  to: number;
  /** Whether this session also runs the whole-passage wrap-up, which finishes learning the passage. */
  wrapUp: boolean;
}

export type Block = ReviewBlock | LearnBlock;

export interface Unit {
  kind: "announce" | "lead-in" | "learn" | "test" | "fixup" | "listen" | "shadow";
  steps: Step[];
  /** Tests: the phrases tested (indices into the block's phrases), whether the result counts, and which retry this is. */
  test?: { phrases: number[]; graded: boolean; attempt: number };
  /** Tests: marked missed, so a fix-up follows. */
  missed?: boolean;
  /** Learning: how many of the passage's phrases are learned once this unit is done. */
  learned?: number;
}

export type SessionEvent =
  /** `misses` counts the graded cues missed (a cue may cover several phrases). */
  | { kind: "reviewed"; block: ReviewBlock; misses: number; passed: boolean }
  | { kind: "learning"; block: LearnBlock; phrases: number }
  | { kind: "learned"; block: LearnBlock };

/** A missed test gets at most this many fix-up rounds. */
const MAX_FIXUPS = 2;
/** Expected share of tests missed, for time estimates. */
const MISS_RATE = { review: 0.1, learn: 0.15 };

const levelOf = (block: Block) => (block.kind === "review" ? block.level : -1);

function testUnit(block: Block, idx: number[], graded: boolean, opts: DrillOptions): Unit {
  const ps = idx.map((i) => block.phrases[i]);
  return { kind: "test", steps: testSteps(block.episodeId, ps, levelOf(block), opts), test: { phrases: idx, graded, attempt: 0 } };
}

/**
 * After a miss: listen and repeat again, then retry the test (ungraded). A review cue of a sentence
 * or more is too long to repeat in one go, so each of its phrases is heard and repeated once.
 */
function fixupUnit(block: Block, missed: Unit, opts: DrillOptions): Unit {
  const idx = missed.test!.phrases;
  const ps = idx.map((i) => block.phrases[i]);
  const repeat =
    block.kind === "review" && ps.length > 1
      ? ps.flatMap((p) => repeatSteps(block.episodeId, [p], opts, 1))
      : repeatSteps(block.episodeId, ps, opts);
  return {
    kind: "fixup",
    steps: [...repeat, ...testSteps(block.episodeId, ps, levelOf(block), opts)],
    test: { phrases: idx, graded: false, attempt: missed.test!.attempt + 1 },
  };
}

const announceUnit = (text: string): Unit => ({ kind: "announce", steps: announceSteps(text) });

/** What's announced as a block starts: the kind of work and, when it has one, the passage's title. */
export function blockAnnouncement(block: Block): string {
  const [what, untitled] =
    block.kind === "review"
      ? ["Review", "Review."]
      : block.from === 0
        ? ["New passage", "New passage."]
        : ["Continuing", "Continuing the passage."];
  return block.passageTitle ? `${what}: ${block.passageTitle}.` : untitled;
}

function leadInUnit(block: Block): Unit | undefined {
  const p = block.kind === "learn" && block.from > 0 ? block.phrases[block.from - 1] : block.leadIn;
  return p ? { kind: "lead-in", steps: leadInSteps(block.episodeId, p) } : undefined;
}

/** Learning phrase k: meaning, listen and repeat, a first try from the English, then joined to the phrase before. */
export function learnGroupUnits(block: LearnBlock, k: number, opts: DrillOptions): Unit[] {
  const p = block.phrases[k];
  const units: Unit[] = [{ kind: "learn", steps: learnSteps(block.episodeId, p, opts) }];
  if (p.english) units.push(testUnit(block, [k], false, opts));
  if (k > 0 && hasEnglish([block.phrases[k - 1], p])) units.push(testUnit(block, [k - 1, k], false, opts));
  units[units.length - 1].learned = k + 1;
  return units;
}

/** Shadowing a whole passage, announced. */
const shadowUnits = (block: Block): Unit[] => [
  announceUnit(ANNOUNCE.shadow),
  { kind: "shadow", steps: shadowSteps(block.episodeId, block.phrases) },
];

/** Finishing a passage: every phrase from its English, in order, then the whole passage to shadow. */
export function wrapUpUnits(block: LearnBlock, opts: DrillOptions): Unit[] {
  const tests = block.phrases.flatMap((p, i) => (p.english ? [testUnit(block, [i], false, opts)] : []));
  return [...(tests.length ? [announceUnit(ANNOUNCE.wrapUp), ...tests] : []), ...shadowUnits(block)];
}

/** A block opens with an announcement of what it is, then its lead-in. */
function openingUnits(block: Block): Unit[] {
  const lead = leadInUnit(block);
  return [announceUnit(blockAnnouncement(block)), ...(lead ? [lead] : [])];
}

export function blockUnits(block: Block, opts: DrillOptions): Unit[] {
  const units = openingUnits(block);
  if (block.kind === "review") {
    for (const g of cueGroups(block.phrases, cueSize(block.level))) {
      const p = block.phrases[g[0]];
      // A phrase without English can't be tested, so it's just heard and repeated.
      units.push(p.english ? testUnit(block, g, true, opts) : { kind: "listen", steps: repeatSteps(block.episodeId, [p], opts, 1) });
    }
    units.push(...shadowUnits(block));
    return units;
  }
  for (let k = block.from; k < block.to; k++) units.push(...learnGroupUnits(block, k, opts));
  if (block.wrapUp) units.push(...wrapUpUnits(block, opts));
  return units;
}

/** Estimated time for units, allowing for the fix-ups that some tests will need. */
export function unitsSeconds(block: Block, units: Unit[], opts: DrillOptions): number {
  const rate = MISS_RATE[block.kind];
  return units.reduce(
    (sum, u) => sum + stepsSeconds(u.steps, opts) + (u.test ? rate * stepsSeconds(fixupUnit(block, u, opts).steps, opts) : 0),
    0,
  );
}

export const blockSeconds = (block: Block, opts: DrillOptions) => unitsSeconds(block, blockUnits(block, opts), opts);
export const learnGroupSeconds = (block: LearnBlock, k: number, opts: DrillOptions) =>
  unitsSeconds(block, learnGroupUnits(block, k, opts), opts);
export const wrapUpSeconds = (block: LearnBlock, opts: DrillOptions) => unitsSeconds(block, wrapUpUnits(block, opts), opts);
/** Time for a block's announcement and lead-in. */
export function openingSeconds(block: Block, opts: DrillOptions): number {
  return openingUnits(block).reduce((sum, u) => sum + stepsSeconds(u.steps, opts), 0);
}

/** Every English text a session speaks, cues and announcements, to synthesise before it starts. */
export function sessionEnglish(blocks: Block[], opts: DrillOptions): string[] {
  if (blocks.length === 0) return [];
  const texts = new Set<string>();
  for (const b of blocks) {
    for (const u of blockUnits(b, opts)) {
      for (const { play } of u.steps) if ((play.kind === "english" || play.kind === "announce") && play.text) texts.add(play.text);
    }
  }
  texts.add(ANNOUNCE.end);
  return [...texts];
}

/** What a Missed press did. */
export interface Miss {
  /** The phrases marked missed. */
  phrases: SessionPhrase[];
  /** Whether the current step changed, so the player should start the new current step. */
  jumped: boolean;
  /** Whether it counted for the phrase just answered, pressed while the next English played. */
  late: boolean;
}

export interface Current {
  step: Step;
  unit: Unit;
  block: Block;
  blockIndex: number;
  /** Position within the block, for a progress display. */
  unitIndex: number;
  unitCount: number;
}

export class DrillSession {
  readonly blocks: Block[];
  private readonly opts: DrillOptions;
  private readonly onEvent: (e: SessionEvent) => void;
  private blockIndex = 0;
  private units: Unit[] = [];
  private unitIndex = 0;
  private stepIndex = 0;
  /** Graded tests missed in the current block. */
  private misses = 0;

  constructor(blocks: Block[], opts: DrillOptions, onEvent: (e: SessionEvent) => void) {
    this.blocks = blocks;
    this.opts = opts;
    this.onEvent = onEvent;
    this.enterBlock(0);
  }

  get finished(): boolean {
    return this.blockIndex >= this.blocks.length;
  }

  current(): Current | null {
    if (this.finished) return null;
    const unit = this.units[this.unitIndex];
    return {
      step: unit.steps[this.stepIndex],
      unit,
      block: this.blocks[this.blockIndex],
      blockIndex: this.blockIndex,
      unitIndex: this.unitIndex,
      unitCount: this.units.length,
    };
  }

  /** The current step is over (it finished, or the learner skipped it): move to the next. */
  advance(): void {
    if (this.finished) return;
    const unit = this.units[this.unitIndex];
    if (++this.stepIndex < unit.steps.length) return;
    this.finishUnit(unit);
  }

  /**
   * Whether Missed means anything now: during a test, from its English cue to just after the
   * answer, or while English plays straight after a test (see missed).
   */
  canMiss(): boolean {
    const cur = this.current();
    if (!cur) return false;
    if (this.lateTarget()) return true;
    return !!cur.unit.test && (cur.step.cue === "english" || cur.step.cue === "speak" || cur.step.cue === "answer");
  }

  /**
   * The test just answered, when a press now would be a late one for it: while the English that
   * opens the next unit plays, whether that's the next test's cue (the learner hasn't been asked
   * to say it yet), the next phrase's meaning when learning, or an announcement.
   */
  private lateTarget(): Unit | undefined {
    const unit = this.units[this.unitIndex];
    const prev = this.units[this.unitIndex - 1];
    if (!unit || !prev?.test || prev.missed) return undefined;
    return unit.steps.slice(0, this.stepIndex + 1).every((s) => s.cue === "english" || s.cue === "announce") ? prev : undefined;
  }

  /**
   * Marks a test missed, or returns null if Missed means nothing now. Pressed during the current
   * test's speaking pause (or its English, if nothing was just answered), it marks this test and
   * skips straight to the answer. Pressed just after a test instead (see lateTarget), it's a late
   * press for that test: it gets its fix-up now, and whatever was playing starts again after it.
   */
  missed(): Miss | null {
    if (!this.canMiss()) return null;
    const block = this.blocks[this.blockIndex];
    const unit = this.units[this.unitIndex];
    const phrasesOf = (u: Unit) => u.test!.phrases.map((i) => block.phrases[i]);

    const prev = this.lateTarget();
    if (prev) {
      this.mark(prev);
      if (prev.test!.attempt < MAX_FIXUPS) {
        this.units.splice(this.unitIndex, 0, fixupUnit(block, prev, this.opts));
        this.stepIndex = 0;
        return { phrases: phrasesOf(prev), jumped: true, late: true };
      }
      return { phrases: phrasesOf(prev), jumped: false, late: true };
    }

    this.mark(unit);
    const cue = unit.steps[this.stepIndex].cue;
    if (cue === "english" || cue === "speak") {
      const answer = unit.steps.findIndex((s, i) => i > this.stepIndex && s.cue === "answer");
      if (answer >= 0) {
        this.stepIndex = answer;
        return { phrases: phrasesOf(unit), jumped: true, late: false };
      }
    }
    return { phrases: phrasesOf(unit), jumped: false, late: false };
  }

  private mark(unit: Unit) {
    if (!unit.missed && unit.test!.graded) this.misses++;
    unit.missed = true;
  }

  private enterBlock(i: number) {
    this.blockIndex = i;
    this.units = i < this.blocks.length ? blockUnits(this.blocks[i], this.opts) : [];
    this.unitIndex = 0;
    this.stepIndex = 0;
    this.misses = 0;
    if (i < this.blocks.length && this.units.length === 0) this.enterBlock(i + 1);
  }

  private finishUnit(unit: Unit) {
    const block = this.blocks[this.blockIndex];
    if (unit.test && unit.missed && unit.test.attempt < MAX_FIXUPS) {
      this.units.splice(this.unitIndex + 1, 0, fixupUnit(block, unit, this.opts));
    }
    if (unit.learned !== undefined && block.kind === "learn") this.onEvent({ kind: "learning", block, phrases: unit.learned });
    this.unitIndex++;
    this.stepIndex = 0;
    if (this.unitIndex < this.units.length) return;

    if (block.kind === "review") {
      const tests = this.units.filter((u) => u.test?.graded).length;
      this.onEvent({ kind: "reviewed", block, misses: this.misses, passed: reviewPasses(this.misses, tests) });
    } else if (block.wrapUp) {
      this.onEvent({ kind: "learned", block });
    }
    this.enterBlock(this.blockIndex + 1);
  }
}
