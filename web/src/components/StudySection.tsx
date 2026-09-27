import { useEffect, useState } from "react";
import { disableStudy, prepareStudy, setStudyLevel, subscribeStudyLevels } from "../lib/study";
import { languageLabel } from "../lib/languages";
import type { Study } from "../hooks/useStudy";
import { CEFR_LEVELS, type CefrLevel, type Episode, type PracticeSettings } from "../types";

/** Study-mode controls in the practice settings sheet. */
export function StudySection(props: {
  uid: string;
  episode: Episode;
  language: string;
  study: Study;
  settings: PracticeSettings;
  onChange: (patch: Partial<PracticeSettings>) => void;
}) {
  const { uid, episode, language, study, settings } = props;
  const [levels, setLevels] = useState<Record<string, CefrLevel>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => subscribeStudyLevels(uid, setLevels), [uid]);

  if (language === "auto") {
    return <p className="small muted">Study mode needs the episode's language. Set it and re-transcribe first.</p>;
  }

  const level = levels[language];
  const st = episode.study;
  const { total, done, voiced, chars } = study.progress;

  const run = async (english?: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await prepareStudy(episode.id, language, english);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const requestEnglish = () => {
    const estimate = chars > 0 && done === total ? `about ${chars.toLocaleString()} characters` : "one clip per phrase";
    if (!confirm(`Generate English audio for this episode? This uses ElevenLabs text-to-speech (${estimate}).`)) return;
    void run(true);
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <span>Your level in {languageLabel(language)}</span>
        <select
          className="input"
          style={{ width: "auto", padding: "4px 8px", minHeight: 32 }}
          value={level ?? ""}
          onChange={(e) => void setStudyLevel(uid, language, e.target.value as CefrLevel)}
          aria-label="Your level"
        >
          {!level && <option value="">Not set</option>}
          {CEFR_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>

      {!st?.enabled ? (
        <>
          <button className="btn small primary" disabled={!level || busy} onClick={() => void run()}>
            {busy ? "Starting…" : "Turn on study mode"}
          </button>
          <p className="small muted" style={{ marginTop: 6 }}>
            Claude translates each phrase and explains grammar, idioms and colloquial speech above your level.
          </p>
        </>
      ) : (
        <>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="small">
              Translations:{" "}
              {total === 0 ? "…" : done >= total ? <span className="pill ready">ready</span> : `${done} / ${total}`}
              {st.level && <span className="muted"> · notes for {st.level}</span>}
            </span>
            <button className="btn small" disabled={busy} onClick={() => void disableStudy(uid, episode.id)}>
              Turn off
            </button>
          </div>
          {level && level !== st.level && (
            <button className="btn small" style={{ marginTop: 8 }} disabled={busy} onClick={() => void run()}>
              Redo notes for {level}
            </button>
          )}
          {st.error && done < total && (
            <p className="small error" style={{ marginTop: 6 }}>
              {st.error}{" "}
              <button className="btn small" disabled={busy} onClick={() => void run()}>
                Retry
              </button>
            </p>
          )}

          <label className="row small" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={!!settings.showTranslation}
              onChange={(e) => props.onChange({ showTranslation: e.target.checked })}
            />
            Show the translation under the current phrase
          </label>

          <div style={{ marginTop: 12 }}>
            {!st.english ? (
              <>
                <button className="btn small" disabled={busy} onClick={requestEnglish}>
                  Generate English audio
                </button>
                <p className="small muted" style={{ marginTop: 6 }}>
                  Voices each translation so it can play after the phrase. Off by default because it uses text-to-speech
                  credits.
                </p>
              </>
            ) : (
              <>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="small">
                    English audio:{" "}
                    {total > 0 && voiced >= total ? <span className="pill ready">ready</span> : `${voiced} / ${total}`}
                  </span>
                  <select
                    className="input"
                    style={{ width: "auto", padding: "4px 8px", minHeight: 32 }}
                    value={settings.english ?? "off"}
                    onChange={(e) => props.onChange({ english: e.target.value as PracticeSettings["english"] })}
                    aria-label="When to play English"
                  >
                    <option value="off">Don't play</option>
                    <option value="first">After first play</option>
                    <option value="each">After every play</option>
                  </select>
                </div>
                {st.audioError && voiced < total && (
                  <p className="small error" style={{ marginTop: 6 }}>
                    {st.audioError}{" "}
                    <button className="btn small" disabled={busy} onClick={() => void run(true)}>
                      Retry
                    </button>
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
      {error && (
        <p className="small error" style={{ marginTop: 6 }}>
          {error}
        </p>
      )}
    </div>
  );
}
