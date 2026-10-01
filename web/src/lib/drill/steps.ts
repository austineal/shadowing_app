/**
 * The building blocks of a drill session: what plays, in what order, for learning a phrase,
 * testing it from its English cue, fixing it after a miss, and shadowing a whole passage.
 */
import { SENTENCE_END } from "../segmenter";

/** A phrase as a drill uses it: its audio, its text and (once study material exists) its English. */
export interface SessionPhrase {
  start: number;
  end: number;
  text: string;
  english?: string;
}

export type Play =
  | { kind: "source"; episodeId: string; start: number; end: number; rate: number }
  | { kind: "english"; text: string }
  /** Spoken in the English voice too, after a chime (see announceSteps). */
  | { kind: "announce"; text: string }
  | { kind: "silence"; sec: number };

/** What the learner is doing during a step, which is what the screen shows. */
export type Cue = "announce" | "lead-in" | "english" | "speak" | "answer" | "listen" | "repeat" | "shadow";

export interface Step {
  play: Play;
  cue: Cue;
  /** Target-language text to show, when the step reveals it. */
  text?: string;
  /** English cue to show. */
  english?: string;
  /** For a span of several phrases: the phrases, so the screen can follow along. */
  phrases?: SessionPhrase[];
  /** What the screen calls the step, in place of its cue's usual label: an announcement's own words. */
  label?: string;
}

export interface DrillOptions {
  /** Audio played either side of each phrase. */
  paddingSec: number;
  /** Pause to repeat in, as a multiple of the phrase's played length. */
  gapFactor: number;
  /** Listen-and-repeat plays of each new phrase (and of a missed one). */
  repeats: number;
  /** How many of those plays are slowed down. */
  slowPlays: number;
  slowRate: number;
  /** Extra time to answer after each English cue, on top of the pause sized to the phrase. */
  answerExtraSec: number;
}

export function drillOptions(
  style: "full" | "light",
  base: { paddingMs: number; gapFactor: number; slowRate?: number },
  answerExtraSec = 0,
): DrillOptions {
  return {
    paddingSec: base.paddingMs / 1000,
    gapFactor: base.gapFactor,
    repeats: style === "full" ? 3 : 2,
    slowPlays: style === "full" ? 2 : 0,
    slowRate: Math.min(1, base.slowRate ?? 0.75),
    answerExtraSec: Math.max(0, answerExtraSec),
  };
}

/** A short breath between steps. */
const BEAT_SEC = 1.0;
/** After the answer: time to press Missed before the drill moves on. (A press during the next English still counts; see DrillSession.missed.) */
const GRACE_SEC = 2.0;

const duration = (ps: SessionPhrase[]) => ps[ps.length - 1].end - ps[0].start;

/**
 * Time to say phrases after their English cue: generous while learning (level -1) and at first,
 * closer to the speaker's own pace as the passage matures.
 */
export function speakSeconds(sec: number, level: number, extra = 0): number {
  if (level <= 1) return sec * 1.5 + 2.0 + extra;
  if (level <= 3) return sec * 1.3 + 1.6 + extra;
  return sec * 1.15 + 1.2 + extra;
}

function source(episodeId: string, ps: SessionPhrase[], rate = 1): Play {
  return { kind: "source", episodeId, start: ps[0].start, end: ps[ps.length - 1].end, rate };
}

const textOf = (ps: SessionPhrase[]) => ps.map((p) => p.text).join(" ");

/** Whether every phrase has English to cue it with. */
export const hasEnglish = (ps: SessionPhrase[]) => ps.every((p) => !!p.english);

/** Listen and repeat, `plays` times; the first `slowPlays` are slowed. */
export function repeatSteps(episodeId: string, ps: SessionPhrase[], opts: DrillOptions, plays = opts.repeats): Step[] {
  const steps: Step[] = [];
  const text = textOf(ps);
  for (let n = 1; n <= plays; n++) {
    const rate = n <= opts.slowPlays ? opts.slowRate : 1;
    steps.push({ play: source(episodeId, ps, rate), cue: "listen", text });
    steps.push({ play: { kind: "silence", sec: Math.max(0.8, (duration(ps) / rate) * opts.gapFactor) }, cue: "repeat", text });
  }
  return steps;
}

/** Learning a new phrase: what it means, then listen and repeat. */
export function learnSteps(episodeId: string, p: SessionPhrase, opts: DrillOptions): Step[] {
  const steps: Step[] = [];
  if (p.english) {
    steps.push({ play: { kind: "english", text: p.english }, cue: "english", text: p.text, english: p.english });
    steps.push({ play: { kind: "silence", sec: BEAT_SEC }, cue: "listen", text: p.text });
  }
  return [...steps, ...repeatSteps(episodeId, [p], opts)];
}

/**
 * The English of one or more consecutive phrases, time to say them, then the original as the
 * answer. The text stays hidden until the answer plays; an answer of several phrases is shown a
 * phrase at a time as it plays, then whole.
 */
export function testSteps(episodeId: string, ps: SessionPhrase[], level: number, opts: DrillOptions): Step[] {
  const english = ps.map((p) => p.english ?? "").join(" ");
  const steps: Step[] = [];
  ps.forEach((p, i) => {
    if (i > 0) steps.push({ play: { kind: "silence", sec: 0.3 }, cue: "english", english });
    steps.push({ play: { kind: "english", text: p.english ?? "" }, cue: "english", english });
  });
  const text = textOf(ps);
  steps.push({ play: { kind: "silence", sec: speakSeconds(duration(ps), level, opts.answerExtraSec) }, cue: "speak", english });
  steps.push({ play: source(episodeId, ps), cue: "answer", text, english, ...(ps.length > 1 ? { phrases: ps } : {}) });
  steps.push({ play: { kind: "silence", sec: GRACE_SEC }, cue: "answer", text, english });
  return steps;
}

/** How much a review cues at once: a phrase, a sentence (short ones joined), or a run of sentences. */
export type CueSize = "phrase" | "sentence" | "turn";

/**
 * Cues grow as a passage matures, so that in the end whole stretches come out from one English
 * cue: phrases at first, sentences from level 2 (a three-day gap), runs of sentences from level 4
 * (two weeks).
 */
export function cueSize(level: number): CueSize {
  return level >= 4 ? "turn" : level >= 2 ? "sentence" : "phrase";
}

/** Longest audio one sentence cue covers; a longer sentence is cued in parts. */
const SENTENCE_MAX_SEC = 15;
/** At sentence size, short sentences are joined until a cue covers at least this much ("Yes." on its own is too easy). */
const SENTENCE_MIN_SEC = 6;
/** Longest audio a run of sentences covers. */
const TURN_MAX_SEC = 20;
/** A pause this long isn't joined over: it most likely marks a new speaker or thought. */
const LONG_PAUSE_SEC = 1.2;

/**
 * The phrases a review cues together, as runs of consecutive indices into `ps`. A phrase without
 * English can't be cued, so it stands alone and breaks the run.
 */
export function cueGroups(ps: SessionPhrase[], size: CueSize): number[][] {
  const span = (g: number[]) => ps[g[g.length - 1]].end - ps[g[0]].start;
  const sentences: number[][] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length) sentences.push(cur);
    cur = [];
  };
  ps.forEach((p, i) => {
    if (!p.english) {
      flush();
      sentences.push([i]);
      return;
    }
    if (cur.length && span([...cur, i]) > SENTENCE_MAX_SEC) flush();
    cur.push(i);
    if (size === "phrase" || SENTENCE_END.test(p.text.trim())) flush();
  });
  flush();
  if (size === "phrase") return sentences;

  // Join whole sentences: at sentence size while the cue is still short, at turn size up to the limit.
  const [joinBelow, max] = size === "sentence" ? [SENTENCE_MIN_SEC, SENTENCE_MAX_SEC] : [Infinity, TURN_MAX_SEC];
  const runs: number[][] = [];
  for (const g of sentences) {
    const prev = runs[runs.length - 1];
    const joins =
      !!prev &&
      !!ps[prev[0]].english &&
      !!ps[g[0]].english &&
      span(prev) < joinBelow &&
      span([...prev, ...g]) <= max &&
      ps[g[0]].start - ps[prev[prev.length - 1]].end < LONG_PAUSE_SEC;
    if (joins) prev.push(...g);
    else runs.push([...g]);
  }
  return runs;
}

/** How long the chime before an announcement takes, before the words start. */
export const ANNOUNCE_CHIME_SEC = 0.35;

/** What the announcements between activities say (a passage's start is in blockAnnouncement). */
export const ANNOUNCE = {
  wrapUp: "Now the whole passage, from the English.",
  shadow: "Now shadow along.",
  end: "That's the end of the session.",
};

/**
 * An announcement of what comes next: a chime, a few words in the English voice, and a moment's
 * pause. With the screen off it's the only sign that the activity has changed; the chime sets it
 * apart from the English cues, which are there to be translated.
 */
export function announceSteps(text: string): Step[] {
  const label = text.replace(/[.:]$/, "");
  return [
    { play: { kind: "announce", text }, cue: "announce", label },
    { play: { kind: "silence", sec: 0.5 }, cue: "announce", label },
  ];
}

/** Plays a phrase once for context before the drill picks up after it. */
export function leadInSteps(episodeId: string, p: SessionPhrase): Step[] {
  return [
    { play: source(episodeId, [p]), cue: "lead-in", text: p.text },
    { play: { kind: "silence", sec: 0.6 }, cue: "lead-in", text: p.text },
  ];
}

/** A whole passage straight through, to shadow along with. */
export function shadowSteps(episodeId: string, ps: SessionPhrase[]): Step[] {
  return [
    { play: source(episodeId, ps), cue: "shadow", phrases: ps },
    { play: { kind: "silence", sec: 1.0 }, cue: "shadow", phrases: ps },
  ];
}

/** Rough length of English speech: the on-device voices read about 14 characters a second. */
export function englishSeconds(text: string): number {
  return 0.4 + text.length / 14;
}

export function stepSeconds(step: Step, opts: DrillOptions): number {
  const p = step.play;
  if (p.kind === "silence") return p.sec;
  if (p.kind === "english") return englishSeconds(p.text);
  if (p.kind === "announce") return ANNOUNCE_CHIME_SEC + englishSeconds(p.text);
  return (p.end - p.start + 2 * opts.paddingSec) / p.rate;
}

export function stepsSeconds(steps: Step[], opts: DrillOptions): number {
  return steps.reduce((sum, s) => sum + stepSeconds(s, opts), 0);
}
