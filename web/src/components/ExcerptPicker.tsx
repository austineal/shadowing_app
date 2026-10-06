import { useState } from "react";
import { useDrillPrefs, useNow, useRecentSessions } from "../hooks/useDrills";
import { DEFAULT_SCHEDULE, formatMinutes } from "../lib/drill/labels";
import { formatLearningTime, weeklyPace } from "../lib/drill/pace";
import { phrasesIn, splitPassages } from "../lib/drill/passages";
import { learningSeconds } from "../lib/drill/plan";
import { drillScheduleKey, scheduleForEpisode, scheduleLabel, schedulesOf } from "../lib/drill/schedules";
import { drillOptions } from "../lib/drill/steps";
import { createDrill, planDrillPassages, setSchedule } from "../lib/drill/store";
import { formatTime } from "../lib/format";
import { languageLabel } from "../lib/languages";
import { loadDefaultSettings } from "../lib/settings";
import type { Drill, Episode, Segment } from "../types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Choosing an excerpt of the episode to drill, shown in the practice dock while the learner taps
 * its first and last phrases in the transcript, or after choosing one of Claude's suggestions.
 */
export function ExcerptPicker(props: {
  uid: string;
  episode: Episode;
  language: string;
  segments: Segment[];
  first?: number;
  last?: number;
  /** Title of the suggested section the range came from, if any. */
  title?: string;
  /** Excerpts of this episode already being drilled. */
  existing: Drill[];
  /** How many suggested sections the episode already has (0 when none have been made). */
  suggestions: number;
  onSuggest: () => void;
  onClose: () => void;
}) {
  const { uid, episode, language, segments, first, last } = props;
  const prefs = useDrillPrefs(uid);
  const sessions = useRecentSessions(uid);
  const now = useNow();
  const [chosenKey, setChosenKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();

  const close = (
    <button className="btn small" onClick={props.onClose}>
      {done ? "Done" : "Cancel"}
    </button>
  );
  if (done) {
    return (
      <div className="picker">
        <p className="small">{done}</p>
        <div className="row">{close}</div>
      </div>
    );
  }
  if (first === undefined || last === undefined) {
    return (
      <div className="picker">
        <p>
          {first === undefined
            ? "Tap the first phrase of the excerpt you want to learn to say, or let Claude suggest some."
            : "Now tap its last phrase."}
        </p>
        <div className="row">
          <button className="btn small primary" onClick={props.onSuggest}>
            {props.suggestions > 0 ? `Suggested excerpts (${props.suggestions})` : "Suggest excerpts"}
          </button>
          {close}
        </div>
      </div>
    );
  }

  const picked = segments.slice(Math.min(first, last), Math.max(first, last) + 1);
  const start = picked[0].start;
  const end = picked[picked.length - 1].end;
  const passages = splitPassages(picked);
  const keys = schedulesOf(prefs, language);
  const key = chosenKey ?? scheduleForEpisode(prefs, language, props.existing);
  const schedule = prefs?.schedules[key];
  const opts = drillOptions(schedule?.learning ?? "full", loadDefaultSettings(), schedule?.answerTime ?? 0);
  const learnSec = learningSeconds(
    passages.map((p) => phrasesIn(picked, p.start, p.end)),
    opts,
  );
  const pace = weeklyPace(
    schedule ?? DEFAULT_SCHEDULE,
    (sessions ?? []).filter((l) => drillScheduleKey(l, prefs) === key),
    opts,
    now,
  );
  // Not while adding: the new excerpt reaches the live list (from the local cache) before the write
  // returns, and would count as overlapping itself.
  const overlap = busy ? undefined : props.existing.find((d) => d.start < end && start < d.end);

  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const id = await createDrill(uid, {
        episodeId: episode.id,
        episodeTitle: episode.title,
        title: props.title,
        language,
        schedule: key,
        start,
        end,
        passages,
        learning: null,
      });
      // Titled passages at natural break points replace the pause-based ones on the server when ready.
      void planDrillPassages(id).catch((e) => console.warn("Planning passages failed:", e));
      let msg = `Added to your ${scheduleLabel(key, schedule)} drills. Claude is splitting it into titled passages.`;
      if (!schedule) {
        await setSchedule(uid, key, DEFAULT_SCHEDULE);
        msg += ` ${languageLabel(language)} drills are now scheduled every day for 20 minutes; change that under Drill schedules in the library.`;
      }
      setDone(msg);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="picker">
      {props.title && <p className="picker-title">{props.title}</p>}
      <p>
        <b>
          {formatTime(start)}–{formatTime(end)}
        </b>{" "}
        · {formatMinutes(end - start)} · {picked.length} phrases in {passages.length} {passages.length === 1 ? "passage" : "passages"}
      </p>
      <p className="small muted">
        Learning it takes roughly {formatMinutes(learnSec)} of drilling plus reviews: {formatLearningTime(end - start, pace)} at your{" "}
        {keys.length > 1 ? "this schedule's" : languageLabel(language)} pace.
      </p>
      {keys.length > 1 && (
        <label className="row small">
          Schedule:
          <select
            className="input"
            style={{ width: "auto", padding: "4px 8px", minHeight: 32 }}
            value={key}
            onChange={(e) => setChosenKey(e.target.value)}
          >
            {keys.map((k) => (
              <option key={k} value={k}>
                {scheduleLabel(k, prefs?.schedules[k])}
              </option>
            ))}
          </select>
        </label>
      )}
      {overlap && (
        <p className="small error">
          This overlaps an excerpt you're already drilling ({formatTime(overlap.start)}–{formatTime(overlap.end)}).
        </p>
      )}
      {error && <p className="small error">{error}</p>}
      <div className="row">
        <button className="btn primary small" disabled={busy || !!overlap || !prefs} onClick={() => void add()}>
          {busy ? "Adding…" : "Drill this excerpt"}
        </button>
        {close}
      </div>
    </div>
  );
}
