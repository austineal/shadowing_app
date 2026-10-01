import { useState } from "react";
import { useDrillPrefs, useNow } from "../hooks/useDrills";
import { createCardsDrill } from "../lib/deck";
import { DEFAULT_SCHEDULE } from "../lib/drill/labels";
import { formatProgress, progressOf } from "../lib/drill/progress";
import { drillScheduleKey, scheduleLabel, schedulesOf } from "../lib/drill/schedules";
import { setDrillSchedule, setSchedule } from "../lib/drill/store";
import { languageLabel } from "../lib/languages";
import type { Drill, Episode, Segment } from "../types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Which of the language's schedules a deck is drilled on; shown only when there's a choice. */
function SchedulePicker(props: { keys: string[]; value: string; label: (k: string) => string; onChange: (k: string) => void }) {
  if (props.keys.length < 2) return null;
  return (
    <label className="row small">
      Schedule:
      <select
        className="input"
        style={{ width: "auto", padding: "4px 8px", minHeight: 32 }}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.keys.map((k) => (
          <option key={k} value={k}>
            {props.label(k)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * A deck's drill: its progress and the schedule it's on. A deck joins its language's main
 * schedule when it's built, so starting one here is only needed after it's been removed.
 */
export function DeckDrill(props: {
  uid: string;
  episode: Episode;
  language: string;
  segments: Segment[];
  drill?: Drill;
  onClose: () => void;
}) {
  const { uid, episode, language, segments, drill } = props;
  const prefs = useDrillPrefs(uid);
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();
  const keys = schedulesOf(prefs, language);
  const label = (k: string) => scheduleLabel(k, prefs?.schedules[k]);
  /** The schedule to add the deck to, when it isn't in the drills. */
  const [chosen, setChosen] = useState<string>();
  const key = chosen ?? language;

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await createCardsDrill(uid, episode, language, segments, key);
      let msg = `Added to your ${label(key)} drills. New cards come a few at a time once the reviews are done.`;
      if (prefs && !prefs.schedules[key]) {
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
      <p className="picker-title">{episode.title}</p>
      {drill && !done ? (
        <>
          <p className="small">{formatProgress(progressOf([drill], now)).replace(/^(\d+) of (\d+)/, "$1 of $2 cards")}</p>
          <p className="small muted">
            Each session reviews the cards that are due, in shuffled rounds, then learns new ones five at a time.
          </p>
          <SchedulePicker
            keys={keys}
            value={drillScheduleKey(drill, prefs)}
            label={label}
            onChange={(k) => void setDrillSchedule(uid, drill, k).catch((e) => setError(message(e)))}
          />
        </>
      ) : done ? (
        <p className="small">{done}</p>
      ) : (
        <>
          <p className="small">
            {segments.length} cards, not in your drills at the moment.
          </p>
          <SchedulePicker keys={keys} value={key} label={label} onChange={setChosen} />
        </>
      )}
      {error && <p className="small error">{error}</p>}
      <div className="row">
        {!drill && !done && (
          <button className="btn primary" disabled={busy || segments.length === 0} onClick={() => void start()}>
            {busy ? "Adding…" : "Drill this deck"}
          </button>
        )}
        <button className="btn" onClick={props.onClose}>
          {done || drill ? "Done" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
