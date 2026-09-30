import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useDrillPrefs, useDrills, useNow, useRecentSessions } from "../hooks/useDrills";
import { availability, type Availability } from "../lib/drill/cadence";
import { formatNext } from "../lib/drill/labels";
import { learningDrill } from "../lib/drill/plan";
import { prefetchDrillEnglish } from "../lib/drill/prefetch";
import { drillVoice } from "../lib/drill/prepare";
import { isDue } from "../lib/drill/srs";
import { languageLabel } from "../lib/languages";
import type { Drill, DrillPrefs, DrillSchedule, DrillSessionLog } from "../types";

interface Row {
  language: string;
  schedule: DrillSchedule;
  availability: Availability;
  due: number;
  learning?: Drill;
  excerpts: number;
  /** The most recently chosen excerpt, whose episode is where the next one most likely comes from. */
  latest?: Drill;
}

/** One row per scheduled language, due ones first. */
function buildRows(prefs: DrillPrefs, drills: Drill[], sessions: DrillSessionLog[], now: number): Row[] {
  return Object.keys(prefs.schedules)
    .map((language) => {
      const schedule = prefs.schedules[language];
      const mine = drills.filter((d) => d.language === language);
      const counted = sessions.filter((s) => s.language === language && s.progress > 0);
      return {
        language,
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
        Number(b.availability.due) - Number(a.availability.due) || languageLabel(a.language).localeCompare(languageLabel(b.language)),
    );
}

/** The library's list of drill sessions: which languages are due now and when the others come up. */
export function DrillToday({ uid }: { uid: string }) {
  const prefs = useDrillPrefs(uid);
  const drills = useDrills(uid);
  const sessions = useRecentSessions(uid);
  const now = useNow();
  const rows = prefs && drills && sessions ? buildRows(prefs, drills, sessions, now) : undefined;

  // While the library is open, make the English for the next sessions (due languages first) so
  // they start at once. Leaving the page stops it.
  const voice = drillVoice(prefs);
  const toPrepare = (rows ?? [])
    .filter((r) => r.excerpts > 0)
    .map((r) => r.language)
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
        <b>Drill</b>: learn to say passages of an episode from their English, on a schedule for each language.{" "}
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
        <TodayRow key={r.language} row={r} now={now} />
      ))}
    </section>
  );
}

function TodayRow({ row, now }: { row: Row; now: number }) {
  const { language, schedule, availability: a, due, learning } = row;
  const work = due > 0 || !!learning;
  const detail =
    row.excerpts === 0
      ? "No excerpt yet: open an episode and tap Drill"
      : [due ? `${due} ${due === 1 ? "passage" : "passages"} to review` : "", learning ? `learning ${learning.title ?? learning.episodeTitle}` : ""]
          .filter(Boolean)
          .join(" · ") || "All caught up";
  const perDay = schedule.everyDays <= 1 && schedule.perDay > 1;
  return (
    <div className="drill-row">
      <div className="body">
        <div className="title">
          {languageLabel(language)}
          <span className="muted small">
            {" "}
            · {schedule.minutes} min
            {perDay ? ` · session ${Math.min(a.doneToday + 1, schedule.perDay)} of ${schedule.perDay}` : ""}
          </span>
        </div>
        <div className="meta">{detail}</div>
        {row.latest && !learning && schedule.newMaterial && (
          <Link to={`/episode/${row.latest.episodeId}?drill=suggest`} className="small">
            Choose the next excerpt ›
          </Link>
        )}
      </div>
      {work &&
        (a.due ? (
          <Link to={`/drill/${language}`} className="btn primary small">
            Start
          </Link>
        ) : (
          <div className="next">
            <span className="small muted">Next {a.next ? formatNext(a.next, now) : "later"}</span>
            <Link to={`/drill/${language}`} className="small">
              Extra session
            </Link>
          </div>
        ))}
    </div>
  );
}
