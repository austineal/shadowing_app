import { useEffect, useState } from "react";
import { disableStudy, prepareStudy, setStudyLevel, subscribeStudyLevels } from "../lib/study";
import { ENGLISH_VOICES, loadVoice, synthesize } from "../lib/tts/client";
import { languageLabel } from "../lib/languages";
import type { Study } from "../hooks/useStudy";
import { CEFR_LEVELS, type CefrLevel, type Episode, type PracticeSettings } from "../types";
import { Info } from "./Info";

/** Study-mode controls in the practice settings sheet. */
export function StudySection(props: {
  uid: string;
  episode: Episode;
  language: string;
  study: Study;
  /** Drills need study mode, so it can't be turned off while the episode is drilled. */
  drilled: boolean;
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
  const { total, done } = study.progress;

  const run = async (retry = false) => {
    setBusy(true);
    setError(undefined);
    try {
      await prepareStudy(episode.id, language, retry);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
          <Info>Claude translates each phrase and explains grammar, idioms and colloquial speech above your level.</Info>
        </>
      ) : (
        <>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="small">
              Translations:{" "}
              {total === 0 ? "…" : done >= total ? <span className="pill ready">ready</span> : `${done} / ${total}`}
              {st.level && <span className="muted"> · notes for {st.level}</span>}
              {props.drilled && <Info>Drills use these translations, so study mode stays on while it's drilled.</Info>}
            </span>
            <button
              className="btn small"
              disabled={busy || props.drilled}
              title={props.drilled ? "Drills need study mode; remove this episode's drills first" : undefined}
              onClick={() => void disableStudy(uid, episode.id)}
            >
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
              <button className="btn small" disabled={busy} onClick={() => void run(true)}>
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

          <EnglishAudio study={study} settings={settings} onChange={props.onChange} />
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

/** English translation audio, generated on this device. */
function EnglishAudio(props: { study: Study; settings: PracticeSettings; onChange: (patch: Partial<PracticeSettings>) => void }) {
  const { study, settings } = props;
  const voiceId = settings.englishVoice ?? ENGLISH_VOICES[0].id;
  const [download, setDownload] = useState<{ loaded: number; total: number }>();
  const [error, setError] = useState<string>();

  const fetchVoice = async () => {
    setError(undefined);
    setDownload({ loaded: 0, total: 0 });
    try {
      await loadVoice(voiceId, (loaded, total) => setDownload({ loaded, total }));
      study.refreshVoice();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownload(undefined);
    }
  };

  const sample = async () => {
    const buf = await synthesize(voiceId, "This is how the English translations will sound.");
    const ctx = new AudioContext();
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    node.onended = () => void ctx.close();
    node.start();
  };

  return (
    <div style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="small">English voice</span>
        <select
          className="input"
          style={{ width: "auto", padding: "4px 8px", minHeight: 32 }}
          value={voiceId}
          onChange={(e) => props.onChange({ englishVoice: e.target.value })}
          aria-label="English voice"
        >
          {ENGLISH_VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      {!study.voiceReady ? (
        <>
          <button className="btn small" style={{ marginTop: 8 }} disabled={!!download} onClick={() => void fetchVoice()}>
            {download
              ? download.total
                ? `Downloading ${Math.round((download.loaded / download.total) * 100)}%…`
                : "Downloading…"
              : "Download voice (about 60 MB)"}
          </button>
          <Info>
            The translations are read aloud on this device, so the voice is downloaded once and then works offline. Keep the
            screen on while it downloads.
          </Info>
        </>
      ) : (
        <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
          <button className="btn small" onClick={() => void sample().catch((e) => setError(String(e)))}>
            ▶ Try voice
          </button>
          <select
            className="input"
            style={{ width: "auto", padding: "4px 8px", minHeight: 32 }}
            value={settings.english ?? "off"}
            onChange={(e) => props.onChange({ english: e.target.value as PracticeSettings["english"] })}
            aria-label="When to play English"
          >
            <option value="off">Don't play English</option>
            <option value="first">English after first play</option>
            <option value="each">English after every play</option>
          </select>
        </div>
      )}
      {error && <p className="small error" style={{ marginTop: 6 }}>{error}</p>}
    </div>
  );
}
