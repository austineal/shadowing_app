import { useMemo } from "react";
import type { SessionTimes } from "../lib/drill/cadence";
import { forecastLoad, sessionDays } from "../lib/drill/forecast";
import { formatDay, formatMinutes } from "../lib/drill/labels";
import { scheduleOptions } from "../lib/drill/prepare";
import { dayNumber, dayStart } from "../lib/drill/srs";
import type { Drill, DrillSchedule } from "../types";

const DAYS = 14;

/**
 * A language's reviews over the next two weeks, if they all go well: a bar for each session day,
 * full height being the time that day's sessions have. The rest of a session learns new passages.
 */
export function ReviewForecast(props: { schedule: DrillSchedule; drills: Drill[]; sessions: SessionTimes[]; now: number }) {
  const { schedule, drills, sessions, now } = props;
  const load = useMemo(
    () => forecastLoad(drills.flatMap((d) => d.passages), sessionDays(schedule, sessions, now, DAYS), now, scheduleOptions(schedule)),
    [schedule, drills, sessions, now],
  );
  if (!load.some((d) => d.reviews > 0)) return null;

  const share = (d: (typeof load)[number]) => d.reviewSec / d.capacitySec;
  const busiest = load.reduce((a, d) => (share(d) > share(a) ? d : a));
  const today = dayNumber(now);
  const amount = (d: (typeof load)[number]) => `about ${formatMinutes(d.reviewSec)} of reviews in ${formatMinutes(d.capacitySec)}`;
  const day = (d: (typeof load)[number]) => formatDay(d.day, now);
  return (
    <div className="forecast">
      <div className="small">Reviews ahead</div>
      <div className="forecast-bars">
        {load.map((d) => (
          <div
            key={d.day}
            className={`fday ${share(d) > 1 ? "over" : ""} ${d.day === today ? "today" : ""}`}
            title={`${day(d).charAt(0).toUpperCase()}${day(d).slice(1)}: ${amount(d)}`}
          >
            <div className="fbar">
              <div style={{ height: `${Math.min(1, share(d)) * 100}%` }} />
            </div>
            <span>{new Date(dayStart(d.day)).toLocaleDateString(undefined, { weekday: "narrow" })}</span>
          </div>
        ))}
      </div>
      <div className="small muted">
        Busiest: {day(busiest)}, with {amount(busiest)}
        {share(busiest) > 1 ? ", so some will wait for the next session" : ""}.
        {schedule.newMaterial && " New passages wait while one more would overfill a session in the coming week."}
      </div>
    </div>
  );
}
