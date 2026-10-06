import { useState } from "react";
import { useStudyLevels } from "../hooks/useLive";
import { languageLabel } from "../lib/languages";
import { prepareStudy, setStudyLevel } from "../lib/study";
import { CEFR_LEVELS, type CefrLevel, type Episode } from "../types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Shown in the practice dock instead of the drill controls while the episode or deck has study
 * mode off: drills cue each phrase with its translation, which study mode provides.
 */
export function DrillNeedsStudy(props: { uid: string; episode: Episode; language: string; onClose: () => void }) {
  const { uid, episode, language } = props;
  const levels = useStudyLevels(uid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const level = levels[language];
  const what = episode.kind === "deck" ? "deck" : "episode";

  // The dock switches to the drill controls once the episode's study mode reads as on.
  const turnOn = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await prepareStudy(episode.id, language);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <div className="picker">
      <p>Drilling needs study mode for this {what}: Claude's translations are the English cues you answer from.</p>
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
        <button className="btn primary small" disabled={busy || !level} onClick={() => void turnOn()}>
          {busy ? "Starting…" : "Turn on study mode"}
        </button>
        <button className="btn small" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
