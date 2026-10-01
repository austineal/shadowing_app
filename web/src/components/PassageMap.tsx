import { formatNext } from "../lib/drill/labels";
import { STAGE_LABEL, formatProgress, passageStage, progressOf, type PhraseMark } from "../lib/drill/progress";
import { isDue } from "../lib/drill/srs";
import type { Drill } from "../types";

/**
 * An excerpt as a strip of its passages, each as wide as its audio and coloured by how well it's
 * known; due passages are underlined.
 */
export function PassageMap({ drill, now }: { drill: Drill; now: number }) {
  return (
    <div className="passage-map" role="img" aria-label={formatProgress(progressOf([drill], now))}>
      {drill.passages.map((p, i) => {
        const stage = passageStage(drill, i);
        const due = isDue(p, now);
        const when = p.due === undefined || due ? "" : `, next review ${formatNext(p.due, now)}`;
        return (
          <span
            key={i}
            className={`pm st-${stage} ${due ? "due" : ""}`}
            style={{ flexGrow: Math.max(1, p.end - p.start) }}
            title={`${p.title ?? `Passage ${i + 1}`}: ${STAGE_LABEL[stage]}${due ? ", due" : when}`}
          />
        );
      })}
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
