import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useEpisode, useSegmentsDoc } from "../hooks/useEpisode";
import { useSegmentPlayer } from "../hooks/useSegmentPlayer";
import { alignTranscript } from "../lib/align";
import {
  audioUrl,
  loadText,
  loadTokens,
  loadWordsFile,
  retranscribe,
  saveAlignedTokens,
  saveEpisodeSettings,
  saveSegments,
  saveTranscript,
  updateEpisode,
  updateSegmentList,
} from "../lib/episodes";
import { formatTime } from "../lib/format";
import { isCharBased, languageLabel } from "../lib/languages";
import { mergeSegments, segmentTokens, splitSegment } from "../lib/segmenter";
import { loadDefaultSettings, saveDefaultSettings } from "../lib/settings";
import type { Episode, PracticeSettings, Segment, SegmentsDoc, TimedToken } from "../types";

export default function Practice({ uid }: { uid: string }) {
  const { id = "" } = useParams();
  const { episode, error: epError } = useEpisode(uid, id);
  const { segDoc, error: segError } = useSegmentsDoc(uid, id);

  if (epError || segError) {
    return <Shell title="Error">{<p className="error section">{epError ?? segError}</p>}</Shell>;
  }
  if (episode === undefined || segDoc === undefined) {
    return (
      <Shell title="Loading…">
        <div className="center">
          <div className="spinner" />
        </div>
      </Shell>
    );
  }
  if (episode === null) {
    return (
      <Shell title="Not found">
        <p className="section muted">This episode no longer exists.</p>
      </Shell>
    );
  }
  if (episode.status !== "ready") return <StatusView episode={episode} />;
  if (segDoc === null) return <Generate uid={uid} episode={episode} />;
  return <Player uid={uid} episode={episode} segDoc={segDoc} />;
}

function Shell({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="page practice">
      <header className="topbar">
        <Link to="/" className="btn ghost icon" aria-label="Back">
          ‹
        </Link>
        <h1>{title}</h1>
        {right}
      </header>
      {children}
    </div>
  );
}

/** Shown while the episode is uploading/transcribing or after an error. */
function StatusView({ episode }: { episode: Episode }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const retry = async () => {
    setBusy(true);
    setMsg(undefined);
    try {
      const r = await retranscribe(episode.id);
      if (r.status === "error") setMsg(r.error ?? "Failed again.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title={episode.title}>
      <div className="center" style={{ flex: 1 }}>
        {episode.status === "error" ? (
          <>
            <p className="error">Transcription failed</p>
            <p className="small muted" style={{ maxWidth: 480 }}>{episode.error}</p>
            <button className="btn primary" disabled={busy} onClick={() => void retry()}>
              {busy ? "Retrying…" : "Retry transcription"}
            </button>
            {msg && <p className="error small">{msg}</p>}
          </>
        ) : (
          <>
            <div className="spinner" />
            <p>{episode.status === "transcribing" ? "Transcribing…" : "Uploading…"}</p>
            <p className="small muted">
              Long episodes can take a few minutes. You can leave this page; it will be ready when you come back.
            </p>
          </>
        )}
      </div>
    </Shell>
  );
}

/** Builds the phrase list the first time an episode is opened. */
function Generate({ uid, episode }: { uid: string; episode: Episode }) {
  const [error, setError] = useState<string>();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void generateSegments(uid, episode, loadDefaultSettings()).catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [uid, episode]);
  return (
    <Shell title={episode.title}>
      <div className="center" style={{ flex: 1 }}>
        {error ? <p className="error">{error}</p> : <div className="spinner" />}
        {!error && <p className="muted">Preparing phrases…</p>}
      </div>
    </Shell>
  );
}

function effectiveLanguage(episode: Episode): string {
  return episode.language !== "auto" ? episode.language : (episode.detectedLanguage ?? "auto");
}

async function generateSegments(uid: string, episode: Episode, settings: PracticeSettings): Promise<void> {
  if (!episode.wordsPath) throw new Error("No transcription available.");
  const words = await loadWordsFile(episode.wordsPath);
  const language = effectiveLanguage(episode);
  let tokens: TimedToken[] = words.words;
  let tokensPath = episode.wordsPath;
  let source: SegmentsDoc["source"] = "asr";
  let matchRatio: number | undefined;

  if (episode.transcriptPath) {
    const transcript = await loadText(episode.transcriptPath);
    const aligned = alignTranscript(transcript, words.words, language);
    if (aligned.tokens.length > 0) {
      tokens = aligned.tokens;
      tokensPath = await saveAlignedTokens(uid, episode.id, tokens);
      source = "transcript";
      matchRatio = aligned.matchRatio;
    }
  }

  const segments = segmentTokens(tokens, { maxPhraseSec: settings.maxPhraseSec, minPhraseSec: settings.minPhraseSec });
  await saveSegments(uid, episode.id, {
    segments,
    source,
    tokensPath,
    maxPhraseSec: settings.maxPhraseSec,
    ...(matchRatio !== undefined ? { matchRatio } : {}),
  });
}

function Player({ uid, episode, segDoc }: { uid: string; episode: Episode; segDoc: SegmentsDoc }) {
  const segments = segDoc.segments;
  const language = effectiveLanguage(episode);
  const charBased = isCharBased(language);

  const [settings, setSettings] = useState<PracticeSettings>(() => ({ ...loadDefaultSettings(), ...episode.settings }));
  const [src, setSrc] = useState<string>();
  const [showSettings, setShowSettings] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tokens, setTokens] = useState<TimedToken[] | null>(null);
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    audioUrl(episode.audioPath).then((u) => !cancelled && setSrc(u), (e) => setNotice(String(e)));
    return () => {
      cancelled = true;
    };
  }, [episode.audioPath]);

  const player = useSegmentPlayer(src, { segments, settings, title: episode.title });

  // Resume where the user left off (once).
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || segments.length === 0) return;
    resumed.current = true;
    const i = Math.min(episode.lastSegmentIndex ?? 0, segments.length - 1);
    if (i > 0) player.select(i);
  }, [segments.length, episode.lastSegmentIndex, player]);

  // Persist position (debounced).
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (player.index !== (episode.lastSegmentIndex ?? 0)) {
        void updateEpisode(uid, episode.id, { lastSegmentIndex: player.index });
      }
    }, 1500);
    return () => window.clearTimeout(t);
  }, [player.index, uid, episode.id, episode.lastSegmentIndex]);

  // Persist settings (debounced) both globally and on the episode.
  useEffect(() => {
    const t = window.setTimeout(() => {
      saveDefaultSettings(settings);
      void saveEpisodeSettings(uid, episode.id, settings);
    }, 800);
    return () => window.clearTimeout(t);
  }, [settings, uid, episode.id]);

  // Keep the current phrase in view.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${player.index}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [player.index]);

  // Keyboard shortcuts (desktop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA" || (e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === " ") {
        e.preventDefault();
        player.toggle();
      } else if (e.key === "ArrowRight") player.next();
      else if (e.key === "ArrowLeft") player.prev();
      else if (e.key === "r") player.replay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player]);

  const ensureTokens = useCallback(async (): Promise<TimedToken[]> => {
    if (tokens) return tokens;
    const t = await loadTokens(segDoc.tokensPath);
    setTokens(t);
    return t;
  }, [tokens, segDoc.tokensPath]);

  const persistSegments = async (next: Segment[], keepIndex: number) => {
    await updateSegmentList(uid, episode.id, next);
    player.select(Math.max(0, Math.min(keepIndex, next.length - 1)));
  };

  const onSplit = async (i: number) => {
    setBusy("split");
    try {
      const t = await ensureTokens();
      const parts = splitSegment(t, segments[i]);
      if (!parts) {
        setNotice("This phrase is a single word and cannot be split.");
        return;
      }
      const next = [...segments.slice(0, i), ...parts, ...segments.slice(i + 1)];
      await persistSegments(next, i);
    } finally {
      setBusy(undefined);
    }
  };

  const onMerge = async (i: number) => {
    if (i + 1 >= segments.length) return;
    const next = [...segments.slice(0, i), mergeSegments(segments[i], segments[i + 1], charBased), ...segments.slice(i + 2)];
    await persistSegments(next, i);
  };

  const onRegenerate = async (maxPhraseSec: number) => {
    if (!confirm("Rebuild all phrases with the new maximum length? Manual splits and merges will be lost.")) return;
    setBusy("regen");
    try {
      const t = await ensureTokens();
      const next = segmentTokens(t, { maxPhraseSec, minPhraseSec: settings.minPhraseSec });
      await saveSegments(uid, episode.id, { ...segDoc, segments: next, maxPhraseSec });
      player.select(0);
      setShowSettings(false);
    } finally {
      setBusy(undefined);
    }
  };

  const onAttachTranscript = async (text: string) => {
    setBusy("transcript");
    try {
      await saveTranscript(uid, episode.id, text);
      await generateSegments(uid, { ...episode, transcriptPath: `users/${uid}/episodes/${episode.id}/transcript.txt` }, settings);
      setTokens(null);
      player.select(0);
      setShowSettings(false);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const current = segments[player.index];
  const modeLabel = useMemo(
    () => ({ manual: "Manual", auto: "Auto-advance", loop: "Loop phrase" })[settings.mode],
    [settings.mode],
  );

  return (
    <div className="page practice">
      <header className="topbar">
        <Link to="/" className="btn ghost icon" aria-label="Back" onClick={() => player.stop()}>
          ‹
        </Link>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{episode.title}</h1>
          <div className="sub">
            {languageLabel(language)} · {segments.length} phrases
            {segDoc.source === "transcript" && segDoc.matchRatio !== undefined
              ? ` · transcript ${Math.round(segDoc.matchRatio * 100)}% matched`
              : ""}
          </div>
        </div>
        <button className={`btn small ${editing ? "primary" : ""}`} onClick={() => setEditing((v) => !v)}>
          {editing ? "Done" : "Edit"}
        </button>
        <button className="btn ghost icon" aria-label="Settings" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
      </header>

      <div className="transcript" ref={listRef}>
        {segments.map((s, i) => (
          <div key={s.id} className="seg-row">
            <button
              data-i={i}
              className={`seg ${i === player.index ? "current" : ""} ${i < player.index ? "done" : ""}`}
              onClick={() => (editing ? player.select(i) : player.playSegment(i))}
            >
              <span className="t">{formatTime(s.start)}</span>
              {s.text}
            </button>
            {editing && (
              <div className="seg-tools">
                <button className="btn small" disabled={!!busy} onClick={() => void onSplit(i)} title="Split at the longest pause">
                  Split
                </button>
                <button
                  className="btn small"
                  disabled={!!busy || i + 1 >= segments.length}
                  onClick={() => void onMerge(i)}
                  title="Merge with next phrase"
                >
                  Merge ↓
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="dock">
        {notice && (
          <p className="small error" onClick={() => setNotice(undefined)}>
            {notice}
          </p>
        )}
        {player.error && <p className="small error">{player.error}</p>}
        <div className={`phrase ${player.phase === "gap" ? "gap" : ""}`}>
          {current ? current.text : "—"}
        </div>
        <div className="progress">
          <div style={{ width: `${Math.round(player.progress * 100)}%` }} />
        </div>
        <div className="row small muted" style={{ justifyContent: "space-between" }}>
          <span>
            {player.index + 1} / {segments.length}
          </span>
          <span>{player.phase === "gap" ? "your turn…" : current ? `${(current.end - current.start).toFixed(1)}s` : ""}</span>
          <span>{formatTime(current?.start)}</span>
        </div>
        <div className="controls">
          <button className="btn icon" onClick={player.prev} disabled={player.index === 0} aria-label="Previous phrase">
            ⏮
          </button>
          <button className="btn icon" onClick={player.replay} aria-label="Repeat phrase" disabled={!src}>
            ↻
          </button>
          <button className="btn primary icon big" onClick={player.toggle} disabled={!src} aria-label="Play or pause">
            {player.phase === "idle" ? "▶" : "⏸"}
          </button>
          <button
            className="btn icon"
            onClick={player.next}
            disabled={player.index + 1 >= segments.length}
            aria-label="Next phrase"
          >
            ⏭
          </button>
        </div>
        <div className="modes">
          {(["manual", "auto", "loop"] as const).map((m) => (
            <button
              key={m}
              className={`btn small ${settings.mode === m ? "active" : ""}`}
              onClick={() => setSettings((s) => ({ ...s, mode: m }))}
            >
              {{ manual: "Manual", auto: "Auto", loop: "Loop" }[m]}
            </button>
          ))}
          <select
            className="input"
            style={{ width: "auto", padding: "4px 8px", minHeight: 32 }}
            value={settings.rate}
            onChange={(e) => setSettings((s) => ({ ...s, rate: Number(e.target.value) }))}
            aria-label="Playback speed"
          >
            {[0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25].map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
        </div>
      </div>

      {showSettings && (
        <SettingsSheet
          settings={settings}
          segDoc={segDoc}
          episode={episode}
          modeLabel={modeLabel}
          busy={busy}
          onChange={setSettings}
          onClose={() => setShowSettings(false)}
          onRegenerate={onRegenerate}
          onAttachTranscript={onAttachTranscript}
        />
      )}
    </div>
  );
}

function SettingsSheet(props: {
  settings: PracticeSettings;
  segDoc: SegmentsDoc;
  episode: Episode;
  modeLabel: string;
  busy?: string;
  onChange: (s: PracticeSettings) => void;
  onClose: () => void;
  onRegenerate: (maxPhraseSec: number) => void;
  onAttachTranscript: (text: string) => void;
}) {
  const { settings, onChange } = props;
  const [maxPhrase, setMaxPhrase] = useState(props.segDoc.maxPhraseSec);
  const [transcript, setTranscript] = useState("");
  const [showTranscript, setShowTranscript] = useState(false);
  const set = (patch: Partial<PracticeSettings>) => onChange({ ...settings, ...patch });

  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Practice settings</h2>

        <div className="slider">
          <div className="row">
            <span>Padding around phrases</span>
            <span className="muted">{settings.paddingMs} ms</span>
          </div>
          <input type="range" min={0} max={400} step={20} value={settings.paddingMs} onChange={(e) => set({ paddingMs: Number(e.target.value) })} />
        </div>
        <div className="slider">
          <div className="row">
            <span>Pause after phrase ({props.modeLabel})</span>
            <span className="muted">{settings.gapFactor.toFixed(1)}× phrase length</span>
          </div>
          <input type="range" min={0.5} max={3} step={0.1} value={settings.gapFactor} onChange={(e) => set({ gapFactor: Number(e.target.value) })} />
        </div>

        <hr />
        <div className="slider">
          <div className="row">
            <span>Maximum phrase length</span>
            <span className="muted">{maxPhrase} s</span>
          </div>
          <input type="range" min={3} max={20} step={1} value={maxPhrase} onChange={(e) => setMaxPhrase(Number(e.target.value))} />
          <div className="row" style={{ marginTop: 6 }}>
            <button
              className="btn small"
              disabled={props.busy !== undefined || maxPhrase === props.segDoc.maxPhraseSec}
              onClick={() => {
                onChange({ ...settings, maxPhraseSec: maxPhrase });
                props.onRegenerate(maxPhrase);
              }}
            >
              {props.busy === "regen" ? "Rebuilding…" : "Rebuild phrases"}
            </button>
            <span className="small muted">Currently built with {props.segDoc.maxPhraseSec} s max.</span>
          </div>
        </div>

        <hr />
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span>
            Text source: <b>{props.segDoc.source === "transcript" ? "your transcript" : "speech recognition"}</b>
          </span>
          <button className="btn small" onClick={() => setShowTranscript((v) => !v)}>
            {props.episode.transcriptPath ? "Replace transcript" : "Attach transcript"}
          </button>
        </div>
        {showTranscript && (
          <div style={{ marginTop: 10 }}>
            <textarea className="input" value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="Paste the transcript text" />
            <button
              className="btn primary small"
              style={{ marginTop: 8 }}
              disabled={!transcript.trim() || props.busy !== undefined}
              onClick={() => props.onAttachTranscript(transcript)}
            >
              {props.busy === "transcript" ? "Aligning…" : "Align and rebuild phrases"}
            </button>
          </div>
        )}

        <hr />
        <p className="small muted">
          Keyboard: space play/pause · ← → previous/next · r repeat. Lock-screen next/previous buttons also work.
        </p>
        <button className="btn" style={{ marginTop: 14, width: "100%" }} onClick={props.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
