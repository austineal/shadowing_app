import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useNow } from "../hooks/useDrills";
import { availability, type Availability } from "../lib/drill/cadence";
import { formatNext } from "../lib/drill/labels";
import { learningDrill } from "../lib/drill/plan";
import { prefetchDrillEnglish } from "../lib/drill/prefetch";
import { drillVoice } from "../lib/drill/prepare";
import { isDue } from "../lib/drill/srs";
import { drillScheduleKey, logScheduleKey, scheduleLabel } from "../lib/drill/schedules";
import type { Drill, DrillPrefs, DrillSchedule, DrillSessionLog } from "../types";
import { Info } from "./Info";
import { PassageMap } from "./PassageMap";

interface Row {
  key: string;
  label: string;
  schedule: DrillSchedule;
  availability: Availability;
  due: number;
  learning?: Drill;
  excerpts: number;
  /** The most recently chosen excerpt, whose episode is where the next one most likely comes from. */
  latest?: Drill;
}

/** One row per schedule, due ones first. */
function buildRows(prefs: DrillPrefs, drills: Drill[], sessions: DrillSessionLog[], now: number): Row[] {
  return Object.keys(prefs.schedules)
    .map((key) => {
      const schedule = prefs.schedules[key];
      const mine = drills.filter((d) => drillScheduleKey(d, prefs) === key);
      const counted = sessions.filter((s) => logScheduleKey(s, prefs) === key && s.progress > 0);
      return {
        key,
        label: scheduleLabel(key, schedule),
        schedule,
        availability: availability(schedule, counted, now),
        due: mine.reduce((n, d) => n + d.passages.filter((p) => isDue(p, now)).length, 0),
        learning: schedule.newMaterial ? learningDrill(mine.map((drill) => ({ drill })))?.drill : undefined,
        excerpts: mine.length,
        latest: mine.reduce<Drill | undefined>((a, d) => (!a || d.createdAt > a.createdAt ? d : a), undefined),
      };
    })
    .sort(
      (a, b) =>
        Number(b.availability.due) - Number(a.availability.due) || a.label.localeCompare(b.label),
    );
}

/**
 * The library's list of drill sessions: which languages are due now and when the others come up.
 * The library loads the data, so it knows when this is in place (see useScrollMemory there).
 */
export function DrillToday({
  uid,
  prefs,
  drills,
  sessions,
}: {
  uid: string;
  prefs?: DrillPrefs;
  drills?: Drill[];
  sessions?: DrillSessionLog[];
}) {
  const now = useNow();
  const rows = prefs && drills && sessions ? buildRows(prefs, drills, sessions, now) : undefined;

  // While the library is open, make the English for the next sessions (due languages first) so
  // they start at once. Leaving the page stops it.
  const voice = drillVoice(prefs);
  const toPrepare = (rows ?? [])
    .filter((r) => r.excerpts > 0)
    .map((r) => r.key)
    .join(",");
  useEffect(() => {
    if (!toPrepare) return;
    let cancelled = false;
    const t = window.setTimeout(() => void prefetchDrillEnglish(uid, toPrepare.split(","), voice, () => cancelled), 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [uid, toPrepare, voice]);

  if (!rows) return null;
  if (rows.length === 0) {
    return (
      <p className="drill-intro small muted">
        <b>Drill</b>
        <Info>Learn to say passages of an episode from their English, on a schedule for each language.</Info>
        <Link to="/drill/settings">Set up ›</Link>
      </p>
    );
  }

  return (
    <section className="drill-today">
      <div className="row">
        <h2>Drills</h2>
        <span className="spacer" />
        <Link to="/drill/settings" className="btn ghost small">
          Schedules
        </Link>
      </div>
      {rows.map((r) => (
        <TodayRow key={r.key} row={r} now={now} />
      ))}
    </section>
  );
}

function TodayRow({ row, now }: { row: Row; now: number }) {
  const { key, label, schedule, availability: a, due, learning } = row;
  const work = due > 0 || !!learning;
  const detail =
    row.excerpts === 0
      ? "No excerpt yet: open an episode and tap Drill"
      : [due ? `${due} to review` : "", learning ? `learning ${learning.title ?? learning.episodeTitle}` : ""]
          .filter(Boolean)
          .join(" · ") || "All caught up";
  const perDay = schedule.everyDays <= 1 && schedule.perDay > 1;
  // The excerpt being learned, else the latest, as a strip of its passages.
  const shown = learning ?? row.latest;
  return (
    <div className="drill-row">
      <div className="body">
        <div className="title">
          {label}
          <span className="muted small">
            {" "}
            · {schedule.minutes} min
            {perDay ? ` · session ${Math.min(a.doneToday + 1, schedule.perDay)} of ${schedule.perDay}` : ""}
          </span>
        </div>
        <div className="meta">{detail}</div>
        {shown && (
          <Link to={`/episode/${shown.episodeId}`} className="today-map" title="Open the excerpt's episode">
            <PassageMap drill={shown} now={now} />
          </Link>
        )}
        {row.latest && !learning && schedule.newMaterial && (
          <Link to={`/episode/${row.latest.episodeId}?drill=suggest`} className="small">
            Choose the next excerpt ›
          </Link>
        )}
      </div>
      {work &&
        (a.due ? (
          <Link to={`/drill/${key}`} className="btn primary small">
            Start
          </Link>
        ) : (
          <div className="next">
            <span className="small muted">Next {a.next ? formatNext(a.next, now) : "later"}</span>
            <Link to={`/drill/${key}`} className="small">
              Extra session
            </Link>
          </div>
        ))}
    </div>
  );
}
