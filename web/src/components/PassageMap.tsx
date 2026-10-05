import { formatNext } from "../lib/drill/labels";
import { STAGE_LABEL, formatProgress, mapCells, progressOf, type MapCell, type PhraseMark } from "../lib/drill/progress";
import type { Drill } from "../types";

/** Up to this many passages show as a strip, each as wide as its audio; more wrap into a grid. */
const STRIP_MAX = 48;
/** The grid shows at most this many cells, grouping runs of passages beyond it (big decks). */
const GRID_MAX = 200;

/** A cell's tooltip: what it holds and how well it's known. */
function cellTitle(drill: Drill, c: MapCell, now: number): string {
  const unit = drill.kind === "cards" ? "Card" : "Passage";
  if (c.to - c.from === 1) {
    const p = drill.passages[c.from];
    const when = p.due === undefined || c.due ? "" : `, next review ${formatNext(p.due, now)}`;
    return `${p.title ?? `${unit} ${c.from + 1}`}: ${STAGE_LABEL[c.stage]}${c.due ? ", due" : when}`;
  }
  const counts = (Object.keys(STAGE_LABEL) as (keyof typeof STAGE_LABEL)[])
    .filter((s) => c.stages[s])
    .map((s) => `${c.stages[s]} ${STAGE_LABEL[s]}`);
  return `${unit}s ${c.from + 1}–${c.to}: ${[...counts, c.due ? `${c.due} due` : ""].filter(Boolean).join(", ")}`;
}

/**
 * An excerpt or deck as a map of its passages, coloured by how well they're known; due ones are
 * underlined. A short excerpt is a strip, each passage as wide as its audio; a long one (a deck of
 * hundreds of cards, say) wraps into a grid of equal cells, grouping runs of cards if need be.
 */
export function PassageMap({ drill, now }: { drill: Drill; now: number }) {
  const grid = drill.passages.length > STRIP_MAX;
  const cells = mapCells(drill, now, grid ? GRID_MAX : Infinity);
  return (
    <div className={`passage-map ${grid ? "grid" : ""}`} role="img" aria-label={formatProgress(progressOf([drill], now))}>
      {cells.map((c) => (
        <span
          key={c.from}
          className={`pm st-${c.stage} ${c.due ? "due" : ""}`}
          style={grid ? undefined : { flexGrow: Math.max(1, c.seconds) }}
          title={cellTitle(drill, c, now)}
        />
      ))}
    </div>
  );
}

/** What the strip's colours mean. */
export function PassageMapKey() {
  return (
    <div className="passage-key small muted">
      {(["learning", "fresh", "growing", "solid"] as const).map((s) => (
        <span key={s}>
          <i className={`stage-dot st-${s}`} />
          {STAGE_LABEL[s]}
        </span>
      ))}
      <span>
        <i className="stage-dot due" />
        due
      </span>
    </div>
  );
}

/** Heads a passage of a drilled excerpt in an episode's transcript (the first passage names the excerpt). */
export function PassageLabel({ mark }: { mark: PhraseMark }) {
  const title = mark.drill.passages[mark.passage].title;
  return (
    <div className="passage-label">
      <i className={`stage-dot st-${mark.stage}`} />
      <span>
        {mark.passage === 0 && <b>{mark.drill.title ?? "Drill excerpt"} · </b>}
        Passage {mark.passage + 1}
        {title ? `: ${title}` : ""} · {STAGE_LABEL[mark.stage]}
        {mark.due ? " · due" : ""}
      </span>
    </div>
  );
}
