import type { PracticeSettings, Segment } from "../types";

/** Extra audio that can follow a phrase (English translation, slow re-reading). */
export type ClipKind = "en" | "slow";

/** What happens after the phrase's source audio finishes, before the next play is decided. */
export type FollowStep = { kind: "clip"; clip: ClipKind } | { kind: "gap" };

/** What to do once a play (source audio plus its follow steps) is complete. */
export type NextAction = { kind: "replay"; keepPlays: boolean } | { kind: "advance" } | { kind: "stop" };

/** Silence after a phrase for the user to speak in: the phrase's real-time length times gapFactor. */
export function gapSeconds(seg: Segment, settings: PracticeSettings): number {
  return Math.max(0.4, ((seg.end - seg.start) / settings.rate) * settings.gapFactor);
}

/** Steps played after the source audio of one play. Manual mode stops straight away. */
export function stepsAfterSource(settings: PracticeSettings): FollowStep[] {
  if (settings.mode === "manual") return [];
  return [{ kind: "gap" }];
}

/**
 * Decides what follows a completed play. `done` is the number of completed plays of the
 * current phrase in this auto-mode pass (always 0 outside auto mode).
 */
export function nextAction(settings: PracticeSettings, done: number, index: number, count: number): NextAction {
  if (settings.mode === "manual") return { kind: "stop" };
  if (settings.mode === "loop") return { kind: "replay", keepPlays: false };
  if (done < Math.max(1, Math.round(settings.repeats))) return { kind: "replay", keepPlays: true };
  if (index + 1 < count) return { kind: "advance" };
  return { kind: "stop" };
}
