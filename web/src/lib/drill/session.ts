/**
 * A drill session: a list of blocks (passages to review or learn) played as a sequence of units,
 * each a short run of steps. The session reacts to Missed presses by jumping to the answer and
 * adding a fix-up, and reports each passage's result as it finishes. It holds no audio; the
 * player asks it for the current step and tells it when that step is over.
 */
import { reviewPasses } from "./srs";
import {
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
  /** The passage's level, which sets how long the learner gets to answer. */
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
  kind: "lead-in" | "learn" | "test" | "fixup" | "listen" | "shadow";
  steps: Step[];
  /** Tests: the phrases tested (indices into the block's phrases), whether the result counts, and which retry this is. */
  test?: { phrases: number[]; graded: boolean; attempt: number };
  /** Tests: marked missed, so a fix-up follows. */
  missed?: boolean;
  /** Learning: how many of the passage's phrases are learned once this unit is done. */
  learned?: number;
}

export type SessionEvent =
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

/** After a miss: listen and repeat again, then retry the test (ungraded). */
function fixupUnit(block: Block, missed: Unit, opts: DrillOptions): Unit {
  const idx = missed.test!.phrases;
  const ps = idx.map((i) => block.phrases[i]);
  return {
    kind: "fixup",
    steps: [...repeatSteps(block.episodeId, ps, opts), ...testSteps(block.episodeId, ps, levelOf(block), opts)],
    test: { phrases: idx, graded: false, attempt: missed.test!.attempt + 1 },
  };
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

/** Finishing a passage: every phrase from its English, in order, then the whole passage to shadow. */
export function wrapUpUnits(block: LearnBlock, opts: DrillOptions): Unit[] {
  const units: Unit[] = [];
  block.phrases.forEach((p, i) => {
    if (p.english) units.push(testUnit(block, [i], false, opts));
  });
  units.push({ kind: "shadow", steps: shadowSteps(block.episodeId, block.phrases) });
  return units;
}

export function blockUnits(block: Block, opts: DrillOptions): Unit[] {
  const units: Unit[] = [];
  const lead = leadInUnit(block);
  if (lead) units.push(lead);
  if (block.kind === "review") {
    block.phrases.forEach((p, i) => {
      // A phrase without English can't be tested, so it's just heard and repeated.
      units.push(p.english ? testUnit(block, [i], true, opts) : { kind: "listen", steps: repeatSteps(block.episodeId, [p], opts, 1) });
    });
    units.push({ kind: "shadow", steps: shadowSteps(block.episodeId, block.phrases) });
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
export function leadInSeconds(block: Block, opts: DrillOptions): number {
  const u = leadInUnit(block);
  return u ? stepsSeconds(u.steps, opts) : 0;
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
  /** Graded phrases missed in the current block (each counts once). */
  private misses = new Set<number>();

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
   * to say it yet) or the next phrase's meaning when learning.
   */
  private lateTarget(): Unit | undefined {
    const unit = this.units[this.unitIndex];
    const prev = this.units[this.unitIndex - 1];
    if (!unit || !prev?.test || prev.missed) return undefined;
    return unit.steps.slice(0, this.stepIndex + 1).every((s) => s.cue === "english") ? prev : undefined;
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
    unit.missed = true;
    if (unit.test!.graded) for (const i of unit.test!.phrases) this.misses.add(i);
  }

  private enterBlock(i: number) {
    this.blockIndex = i;
    this.units = i < this.blocks.length ? blockUnits(this.blocks[i], this.opts) : [];
    this.unitIndex = 0;
    this.stepIndex = 0;
    this.misses = new Set();
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
      const tested = block.phrases.filter((p) => !!p.english).length;
      const misses = this.misses.size;
      this.onEvent({ kind: "reviewed", block, misses, passed: reviewPasses(misses, tested) });
    } else if (block.wrapUp) {
      this.onEvent({ kind: "learned", block });
    }
    this.enterBlock(this.blockIndex + 1);
  }
}
