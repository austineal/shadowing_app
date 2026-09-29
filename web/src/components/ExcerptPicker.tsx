import { useEffect, useState } from "react";
import { useDrillPrefs } from "../hooks/useDrills";
import { DEFAULT_SCHEDULE, formatMinutes } from "../lib/drill/labels";
import { phrasesIn, splitPassages } from "../lib/drill/passages";
import { learningSeconds } from "../lib/drill/plan";
import { drillOptions } from "../lib/drill/steps";
import { createDrill, prepareDrillStudy, setSchedule } from "../lib/drill/store";
import { formatTime } from "../lib/format";
import { languageLabel } from "../lib/languages";
import { loadDefaultSettings } from "../lib/settings";
import { setStudyLevel, subscribeStudyLevels } from "../lib/study";
import { CEFR_LEVELS, type CefrLevel, type Drill, type Episode, type Segment } from "../types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Choosing an excerpt of the episode to drill, shown in the practice dock while the learner taps
 * its first and last phrases in the transcript.
 */
export function ExcerptPicker(props: {
  uid: string;
  episode: Episode;
  language: string;
  segments: Segment[];
  first?: number;
  last?: number;
  /** Excerpts of this episode already being drilled. */
  existing: Drill[];
  onClose: () => void;
}) {
  const { uid, episode, language, segments, first, last } = props;
  const prefs = useDrillPrefs(uid);
  const [levels, setLevels] = useState<Record<string, CefrLevel>>({});
  useEffect(() => subscribeStudyLevels(uid, setLevels), [uid]);
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
        <p>{first === undefined ? "Tap the first phrase of the excerpt you want to learn to say." : "Now tap its last phrase."}</p>
        <div className="row">{close}</div>
      </div>
    );
  }

  const picked = segments.slice(Math.min(first, last), Math.max(first, last) + 1);
  const start = picked[0].start;
  const end = picked[picked.length - 1].end;
  const passages = splitPassages(picked);
  const schedule = prefs?.schedules[language];
  const opts = drillOptions(schedule?.learning ?? "full", loadDefaultSettings());
  const learnSec = learningSeconds(
    passages.map((p) => phrasesIn(picked, p.start, p.end)),
    opts,
  );
  const overlap = props.existing.find((d) => d.start < end && start < d.end);
  const level = levels[language];

  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await createDrill(uid, {
        episodeId: episode.id,
        episodeTitle: episode.title,
        language,
        start,
        end,
        passages,
        learning: null,
      });
      let msg = `Added to your ${languageLabel(language)} drills.`;
      if (!schedule) {
        await setSchedule(uid, language, DEFAULT_SCHEDULE);
        msg += ` ${languageLabel(language)} drills are now scheduled every day for 20 minutes; change that under Drill schedules in the library.`;
      }
      try {
        await prepareDrillStudy({ episodeId: episode.id, language, start, end });
        msg += " Its translations are being prepared, which takes a minute or two.";
      } catch (e) {
        msg += ` The translations couldn't be requested (${message(e)}); a drill session will offer to try again.`;
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
      <p>
        <b>
          {formatTime(start)}–{formatTime(end)}
        </b>{" "}
        · {formatMinutes(end - start)} · {picked.length} phrases in {passages.length} {passages.length === 1 ? "passage" : "passages"}
      </p>
      <p className="small muted">
        Learning it takes roughly {formatMinutes(learnSec)} of drilling, spread over your sessions, plus reviews.
      </p>
      {overlap && (
        <p className="small error">
          This overlaps an excerpt you're already drilling ({formatTime(overlap.start)}–{formatTime(overlap.end)}).
        </p>
      )}
      {!level && (
        <label className="row small">
          Your level in {languageLabel(language)}, for the translations and notes:
          <select
            className="input"
            style={{ width: "auto", padding: "4px 8px", minHeight: 32 }}
            value=""
            onChange={(e) => void setStudyLevel(uid, language, e.target.value as CefrLevel)}
          >
            <option value="">Not set</option>
            {CEFR_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p className="small error">{error}</p>}
      <div className="row">
        <button className="btn primary small" disabled={busy || !!overlap || !level || !prefs} onClick={() => void add()}>
          {busy ? "Adding…" : "Drill this excerpt"}
        </button>
        {close}
      </div>
    </div>
  );
}
