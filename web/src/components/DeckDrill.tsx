import { useState } from "react";
import { useDrillPrefs, useNow } from "../hooks/useDrills";
import { createCardsDrill, deckLessons } from "../lib/deck";
import { DEFAULT_SCHEDULE } from "../lib/drill/labels";
import { formatProgress, progressOf } from "../lib/drill/progress";
import { setSchedule } from "../lib/drill/store";
import { languageLabel } from "../lib/languages";
import type { Drill, Episode, Segment } from "../types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A deck's drill: its progress. A deck joins the drills when it's built, so starting one here is
 * only needed after it's been removed from them.
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
  const lessons = drill?.lessons ?? deckLessons(segments);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await createCardsDrill(uid, episode, language, segments);
      let msg = `Added to your ${languageLabel(language)} drills. New cards come a few at a time once the reviews are done.`;
      if (prefs && !prefs.schedules[language]) {
        await setSchedule(uid, language, DEFAULT_SCHEDULE);
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
            Each session reviews the cards that are due, in shuffled rounds, then learns new ones five at a time
            {lessons.length > 1 ? ", lesson by lesson" : ""}.
          </p>
        </>
      ) : done ? (
        <p className="small">{done}</p>
      ) : (
        <>
          <p className="small">
            {segments.length} cards{lessons.length > 1 ? ` in ${lessons.length} lessons` : ""}, not in your drills at the moment.
          </p>
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
