/**
 * How much of an episode is in drill excerpts, for the library's episode list.
 */
import type { Drill, Episode } from "../../types";

export interface Coverage {
  /** Share of the episode inside excerpts, 0–1. */
  fraction: number;
  /** All of it, give or take what lies outside any excerpt anyway: a lesson's spoken number, a show's intro. */
  full: boolean;
}

/** Audio left outside the excerpts that still counts as all of the episode: this many seconds, or this share of it. */
const SLACK_SEC = 5;
const SLACK_SHARE = 0.05;

/**
 * Coverage of an episode by excerpts of it (time ranges), or undefined when it has none. The
 * episode's length is where its speech ends (see the transcription function), so excerpts reaching
 * the last phrase reach the end.
 */
export function drillCoverage(durationSec: number | undefined, excerpts: { start: number; end: number }[]): Coverage | undefined {
  if (excerpts.length === 0) return undefined;
  const length = durationSec && durationSec > 0 ? durationSec : Math.max(...excerpts.map((e) => e.end));
  const ranges = excerpts
    .map((e) => [Math.max(0, e.start), Math.min(length, e.end)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let reach = 0;
  for (const [s, e] of ranges) {
    if (e <= reach) continue;
    covered += e - Math.max(s, reach);
    reach = e;
  }
  return { fraction: Math.min(1, covered / length), full: length - covered <= Math.max(SLACK_SEC, length * SLACK_SHARE) };
}

/** Coverage of each episode that has excerpts, by episode id. */
export function coverageByEpisode(
  episodes: Pick<Episode, "id" | "durationSec">[],
  drills: Pick<Drill, "episodeId" | "start" | "end">[],
): Map<string, Coverage> {
  const byEpisode = new Map<string, Pick<Drill, "start" | "end">[]>();
  for (const d of drills) byEpisode.set(d.episodeId, [...(byEpisode.get(d.episodeId) ?? []), d]);
  const out = new Map<string, Coverage>();
  for (const ep of episodes) {
    const c = drillCoverage(ep.durationSec, byEpisode.get(ep.id) ?? []);
    if (c) out.set(ep.id, c);
  }
  return out;
}

/** "5% in drills", "All in drills" */
export function formatCoverage(c: Coverage): string {
  return c.full ? "All in drills" : `${Math.max(1, Math.round(c.fraction * 100))}% in drills`;
}
