import type { PracticeSettings, Segment } from "../types";

/** Extra audio that can follow a phrase: currently only its English translation. */
export type ClipKind = "en";

/** What happens after the phrase's source audio finishes, before the next play is decided. */
export type FollowStep = { kind: "pause"; sec: number } | { kind: "clip"; clip: ClipKind } | { kind: "gap" };

/** Silence between the end of a phrase and its English translation, so the switch isn't abrupt. */
export const PAUSE_BEFORE_ENGLISH_SEC = 0.8;

/** What to do once a play (source audio plus its follow steps) is complete. */
export type NextAction = { kind: "replay"; keepPlays: boolean } | { kind: "advance" } | { kind: "stop" };

/** Silence after a phrase for the user to speak in: the phrase's length as played, times gapFactor. */
export function gapSeconds(seg: Segment, settings: PracticeSettings): number {
  return Math.max(0.4, ((seg.end - seg.start) / settings.rate) * settings.gapFactor);
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
