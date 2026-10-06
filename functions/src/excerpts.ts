/**
 * Claude's part in drills: splitting an episode into self-contained sections worth drilling, and
 * splitting a chosen excerpt into titled passages.
 */
import { CEFR_LEVELS, ask, type CefrLevel } from "./claude.js";

const SPEAKING = ["good", "fair", "skip"] as const;

interface Section {
  /** First and last transcript line (inclusive). */
  first: number;
  last: number;
  title: string;
  summary: string;
  /** How good the section is for learning to say. */
  speaking: (typeof SPEAKING)[number];
  why: string;
  /** CEFR level needed to follow it comfortably. */
  level: CefrLevel;
}

interface PlannedPassages {
  /** Title for the whole excerpt. */
  title: string;
  /** Index (into the excerpt's lines) of each passage's first line, ascending from 0, with its title. */
  passages: { first: number; title: string }[];
}

const SECTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sections"],
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["first", "last", "title", "summary", "speaking", "why", "level"],
        properties: {
          first: { type: "integer" },
          last: { type: "integer" },
          title: { type: "string" },
          summary: { type: "string" },
          speaking: { type: "string", enum: [...SPEAKING] },
          why: { type: "string" },
          level: { type: "string", enum: [...CEFR_LEVELS] },
        },
      },
    },
  },
} as const;

const PASSAGES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "passages"],
  properties: {
    title: { type: "string" },
    passages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["first", "title"],
        properties: {
          first: { type: "integer" },
          title: { type: "string" },
        },
      },
    },
  },
} as const;

/** "m:ss" (or "h:mm:ss"). */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

interface SectionsRequest {
  apiKey: string;
  model: string;
  languageName: string;
  level: CefrLevel;
  /** Preferred section length in minutes. */
  minutes: number;
  /** The transcript, one phrase per line with its start time in seconds. */
  lines: { start: number; text: string }[];
  /** Episode length in seconds. */
  durationSec: number;
}

/** Splits an episode into sections, in order and without overlaps. */
export async function suggestSections(req: SectionsRequest): Promise<Section[]> {
  const min = Math.max(1, Math.round(req.minutes * 0.6));
  const max = Math.round(req.minutes * 1.6);
  const system = `You are helping an English speaker who is learning ${req.languageName} choose what to study from a podcast episode. They drill excerpts until they can say them: for each phrase they hear its English translation and say the ${req.languageName} original from memory, working through an excerpt a passage at a time over a couple of weeks and reviewing it for months afterwards.

Split the transcript into consecutive sections that each make a good excerpt: self-contained, starting where a story, topic, question or explanation begins and ending where it wraps up, so that it makes sense without what came before. Aim for about ${req.minutes} minutes each; anything from ${min} to ${max} minutes is fine, and a natural boundary matters more than hitting the length. Cover the whole transcript in order, without overlaps: parts that make poor excerpts (ads, sponsor reads, intros and outros, housekeeping, long lists of names or numbers, crosstalk that's hard to follow) become sections of their own, marked "skip".

For each section:
- first, last: the numbers of its first and last lines.
- title: a short English title, at most eight words, saying what happens in it.
- summary: one English sentence on what it's about.
- speaking: "good" for natural speech the learner would want to be able to say themselves (personal stories, opinions, explanations, everyday conversation), "fair" for usable material that's less so (dense facts, many names or technical terms, fast back-and-forth), or "skip".
- why: one short English sentence on what the learner gets from being able to say it, or why to skip it.
- level: the CEFR level a learner needs to follow it comfortably.

The learner's level is ${req.level}. The transcript comes from speech recognition, so expect some misrecognised words. Each line gives its number, its start time (minutes:seconds) and its text.`;
  const user = `<transcript>
${req.lines.map((l, i) => `${i}\t${clock(l.start)}\t${l.text}`).join("\n")}
</transcript>
The episode ends at ${clock(req.durationSec)}.`;

  const out = await ask<{ sections: Section[] }>({
    apiKey: req.apiKey,
    model: req.model,
    effort: "high",
    schema: SECTIONS_SCHEMA,
    system,
    user,
  });
  return normalizeSections(out.sections, req.lines.length);
}

/** Puts sections in order, within range and without overlaps. Gaps are left as they are. */
function normalizeSections(sections: Section[], lineCount: number): Section[] {
  const out: Section[] = [];
  let next = 0;
  for (const s of [...sections].sort((a, b) => a.first - b.first)) {
    const first = Math.max(next, Math.min(s.first, lineCount - 1));
    const last = Math.min(lineCount - 1, s.last);
    if (!Number.isInteger(first) || !Number.isInteger(last) || last < first) continue;
    out.push({ ...s, first, last, title: s.title.trim(), summary: s.summary.trim(), why: s.why.trim() });
    next = last + 1;
  }
  return out;
}

interface PassagesRequest {
  apiKey: string;
  model: string;
  languageName: string;
  /** The excerpt, one phrase per line with its length in seconds. */
  lines: { duration: number; text: string }[];
}

/** Splits an excerpt into titled passages. */
export async function planPassages(req: PassagesRequest): Promise<PlannedPassages> {
  const system = `You are preparing an excerpt of a ${req.languageName} podcast for an English speaker who will learn to say it: for each phrase they hear its English translation and say the ${req.languageName} original from memory, working through the excerpt a passage at a time.

Split the excerpt into passages of about 40 seconds, anything from 25 to 60 seconds (a single long phrase can be a passage on its own). Break where the speech naturally pauses: at the end of a sentence or a thought, a change of topic or speaker, the next step of a story. Avoid breaking in the middle of a sentence.

Give the excerpt a short English title, at most eight words, saying what it's about, and each passage a short English title, two to six words, saying what happens in it, so the learner can tell the passages apart and follow the story.

Each line gives its number, its length in seconds and its text. Return each passage as the number of its first line; the first passage starts at line 0.`;
  const user = req.lines.map((l, i) => `${i}\t${l.duration.toFixed(1)}s\t${l.text}`).join("\n");
  const out = await ask<PlannedPassages>({
    apiKey: req.apiKey,
    model: req.model,
    effort: "medium",
    schema: PASSAGES_SCHEMA,
    system,
    user,
  });
  return { title: out.title.trim(), passages: out.passages.map((p) => ({ first: p.first, title: p.title.trim() })) };
}

/**
 * Turns passage start lines into time ranges that tile the excerpt, like the app's own splitter:
 * each passage ends halfway through the pause before the next. Starts are cleaned up (sorted,
 * de-duplicated, within range, the first at 0), and a passage shorter than `minSec` joins the one
 * before. Returns null when the result has a passage of several phrases longer than `maxSec`,
 * which means the split can't be trusted.
 */
export function passageRanges(
  lines: { start: number; end: number }[],
  planned: { first: number; title: string }[],
  minSec = 8,
  maxSec = 100,
): { start: number; end: number; title: string }[] | null {
  const n = lines.length;
  if (n === 0) return null;
  const titles = new Map<number, string>();
  for (const p of planned) {
    if (Number.isInteger(p.first) && p.first >= 0 && p.first < n && !titles.has(p.first)) titles.set(p.first, p.title);
  }
  const starts = [...titles.entries()].sort((a, b) => a[0] - b[0]);
  if (starts.length === 0) starts.push([0, ""]);
  starts[0] = [0, starts[0][1]]; // the first passage takes in any lines before it

  // Fold passages that are too short into the one before.
  const kept: [number, string][] = [];
  starts.forEach(([first, title], k) => {
    const last = k + 1 < starts.length ? starts[k + 1][0] - 1 : n - 1;
    if (kept.length === 0 || lines[last].end - lines[first].start >= minSec) kept.push([first, title]);
  });

  const ranges = kept.map(([f, title], k) => {
    const last = k + 1 < kept.length ? kept[k + 1][0] - 1 : n - 1;
    const start = k === 0 ? lines[0].start : (lines[f - 1].end + lines[f].start) / 2;
    const end = last === n - 1 ? lines[n - 1].end : (lines[last].end + lines[last + 1].start) / 2;
    return { start, end, title, phrases: last - f + 1, sec: lines[last].end - lines[f].start };
  });
  if (ranges.some((r) => r.phrases > 1 && r.sec > maxSec)) return null;
  return ranges.map(({ start, end, title }) => ({ start, end, title }));
}
