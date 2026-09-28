import type { PracticeSettings, Segment } from "../types";

/** Extra audio that can follow a phrase (English translation, slow re-reading). */
export type ClipKind = "en" | "slow";

/** What happens after the phrase's source audio finishes, before the next play is decided. */
export type FollowStep = { kind: "pause"; sec: number } | { kind: "clip"; clip: ClipKind } | { kind: "gap" };

/** Silence between the end of a phrase and its English translation, so the switch isn't abrupt. */
export const PAUSE_BEFORE_ENGLISH_SEC = 0.8;

/** What to do once a play (source audio plus its follow steps) is complete. */
export type NextAction = { kind: "replay"; keepPlays: boolean } | { kind: "advance" } | { kind: "stop" };

/**
 * Speed of the source audio on a given play (counting from 1). In auto and loop modes the first
 * `slowPlays` plays of a phrase are slowed to `slowRate`, but never sped up past `rate`.
 */
export function sourceRate(settings: PracticeSettings, playNumber: number): number {
  const slow = settings.mode !== "manual" && playNumber <= (settings.slowPlays ?? 0);
  return slow ? Math.min(settings.rate, settings.slowRate ?? settings.rate) : settings.rate;
}

/** Silence after a phrase for the user to speak in: the phrase's length as just played, times gapFactor. */
export function gapSeconds(seg: Segment, settings: PracticeSettings, playNumber = 1): number {
  return Math.max(0.4, ((seg.end - seg.start) / sourceRate(settings, playNumber)) * settings.gapFactor);
}

/**
 * Steps played after the source audio of one play (`playNumber` counts from 1). The English
 * translation follows the phrase after a short pause, then comes the gap for the user to speak
 * in, which manual mode leaves out.
 */
export function stepsAfterSource(settings: PracticeSettings, playNumber: number): FollowStep[] {
  const steps: FollowStep[] = [];
  if (settings.english === "each" || (settings.english === "first" && playNumber === 1)) {
    steps.push({ kind: "pause", sec: PAUSE_BEFORE_ENGLISH_SEC }, { kind: "clip", clip: "en" });
  }
  if (settings.mode !== "manual") steps.push({ kind: "gap" });
  return steps;
}

/**
 * Decides what follows a completed play. `done` is the number of completed plays of the
 * current phrase since the user last navigated.
 */
export function nextAction(settings: PracticeSettings, done: number, index: number, count: number): NextAction {
  if (settings.mode === "manual") return { kind: "stop" };
  if (settings.mode === "loop") return { kind: "replay", keepPlays: true };
  if (done < Math.max(1, Math.round(settings.repeats))) return { kind: "replay", keepPlays: true };
  if (index + 1 < count) return { kind: "advance" };
  return { kind: "stop" };
}
