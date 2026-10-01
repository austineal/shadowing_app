import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useEpisode, useSegmentsDoc } from "../hooks/useEpisode";
import { useDrills, useExcerptSuggestions, useNow } from "../hooks/useDrills";
import { useSegmentPlayer } from "../hooks/useSegmentPlayer";
import { useStudy, type Study } from "../hooks/useStudy";
import { alignTranscript } from "../lib/align";
import { transcriptMarks } from "../lib/drill/progress";
import {
  ensureAudioUrl,
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
import { isCharBased, languageLabel, normalizeLanguageCode } from "../lib/languages";
import { mergeSegments, segmentTokens, splitSegment } from "../lib/segmenter";
import { episodeSettings, loadDefaultSettings, saveDefaultSettings } from "../lib/settings";
import { useOnline } from "../lib/offline";
import { ExcerptPicker } from "../components/ExcerptPicker";
import { DeckDrill } from "../components/DeckDrill";
import { buildDeck } from "../lib/deck";
import { ExcerptSuggestionsSheet } from "../components/ExcerptSuggestions";
import { OfflineButton } from "../components/OfflineButton";
import { PassageLabel } from "../components/PassageMap";
import { StudySection } from "../components/StudySection";
import { PhraseStudySheet } from "../components/PhraseStudySheet";
import { prepareStudy } from "../lib/study";
import { DEFAULT_ENGLISH_VOICE } from "../lib/tts/client";
import { MAX_REPEATS, REPEAT_PRESETS, type Episode, type PracticeSettings, type Segment, type SegmentsDoc, type TimedToken } from "../types";

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
      const r = episode.kind === "deck" ? await buildDeck(episode.id) : await retranscribe(episode.id);
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
            <p className="error">{episode.kind === "deck" ? "Building the deck failed" : "Transcription failed"}</p>
            <p className="small muted" style={{ maxWidth: 480 }}>{episode.error}</p>
            <button className="btn primary" disabled={busy} onClick={() => void retry()}>
              {busy ? "Retrying…" : episode.kind === "deck" ? "Try again" : "Retry transcription"}
            </button>
            {msg && <p className="error small">{msg}</p>}
          </>
        ) : (
          <>
            <div className="spinner" />
            <p>{episode.status === "transcribing" ? (episode.kind === "deck" ? "Building the deck…" : "Transcribing…") : "Uploading…"}</p>
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

/** Older saved settings have no `repeats`; anything odd collapses to the 1–MAX_REPEATS range. */
function clampRepeats(n: number | undefined): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_REPEATS, Math.max(1, Math.round(n as number)));
}

function effectiveLanguage(episode: Episode): string {
  if (episode.language !== "auto") return episode.language;
  return normalizeLanguageCode(episode.detectedLanguage) ?? "auto";
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
  const isDeck = episode.kind === "deck";
  const charBased = isCharBased(language);

  const [settings, setSettings] = useState<PracticeSettings>(() => episodeSettings(episode.settings));
  const [src, setSrc] = useState<string>();
  const [showSettings, setShowSettings] = useState(false);
  /** Phrase whose study sheet is open. */
  const [studyIndex, setStudyIndex] = useState<number>();
  const [editing, setEditing] = useState(false);
  /** Choosing an excerpt to drill: the first and last phrases tapped so far. */
  // ?drill=suggest (from the library's drill list) opens the picker with Claude's suggestions showing.
  const [searchParams, setSearchParams] = useSearchParams();
  const [picking, setPicking] = useState<{ first?: number; last?: number; title?: string } | null>(() =>
    searchParams.get("drill") && language !== "auto" ? {} : null,
  );
  const [suggesting, setSuggesting] = useState(() => searchParams.get("drill") === "suggest" && language !== "auto" && !isDeck);
  /** The deck's drill sheet is open (decks are drilled whole, card by card, rather than by excerpt). */
  const [deckDrilling, setDeckDrilling] = useState(false);
  const [tokens, setTokens] = useState<TimedToken[] | null>(null);
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const online = useOnline();
  useEffect(() => {
    let cancelled = false;
    ensureAudioUrl(uid, episode).then(
      (u) => !cancelled && setSrc(u),
      (e) =>
        !cancelled &&
        setNotice(
          navigator.onLine
            ? String(e)
            : "You're offline and this episode hasn't been opened online yet, so its audio can't be located.",
        ),
    );
    return () => {
      cancelled = true;
    };
    // Only re-run when the path changes; audioUrl arriving later is handled by ensureAudioUrl's early return.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, episode.id, episode.audioPath]);

  const study = useStudy(uid, episode, segments, language, settings.englishVoice ?? DEFAULT_ENGLISH_VOICE);
  const player = useSegmentPlayer(src, { segments, settings, title: episode.title, getClip: study.getClip });
  const allDrills = useDrills(uid);
  const episodeDrills = useMemo(() => (allDrills ?? []).filter((d) => d.episodeId === episode.id), [allDrills, episode.id]);
  // The drilled excerpts as a map over the transcript: each passage coloured by how well it's known.
  const now = useNow();
  const marks = useMemo(() => transcriptMarks(segments, episodeDrills, now), [segments, episodeDrills, now]);
  const suggestions = useExcerptSuggestions(uid, episode.id);

  // Download English clips for the next few phrases so they're decoded before they're due.
  useEffect(() => {
    if (settings.english && settings.english !== "off") study.prefetch(player.index);
  }, [player.index, settings.english, study]);

  /** Queues study material for new phrase texts after the phrases change. */
  const refreshStudy = () => {
    if (episode.study?.enabled && language !== "auto") void prepareStudy(episode.id, language).catch(() => undefined);
  };

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
      if (document.querySelector(".sheet")) return; // a settings or study sheet is open
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
    refreshStudy();
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
      refreshStudy();
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
      refreshStudy();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const current = segments[player.index];
  const currentStudy = study.phraseAt(player.index);
  const openStudy = () => {
    player.stop();
    setStudyIndex(player.index);
  };
  const sheetPhrase = studyIndex === undefined ? undefined : study.phraseAt(studyIndex);
  const repeats = clampRepeats(settings.repeats);
  const modeLabel = useMemo(
    () => ({ manual: "Manual", auto: "Auto-advance", loop: "Loop phrase" })[settings.mode],
    [settings.mode],
  );

  const isPicked = (i: number) => {
    if (picking?.first === undefined) return false;
    const last = picking.last ?? picking.first;
    return i >= Math.min(picking.first, last) && i <= Math.max(picking.first, last);
  };
  /** First tap sets the start of the excerpt, the second its end; a third starts again. */
  const pick = (i: number) =>
    setPicking((p) => (!p || p.first === undefined || p.last !== undefined ? { first: i } : { first: p.first, last: i }));
  const stopPicking = () => {
    setPicking(null);
    setSuggesting(false);
    if (searchParams.has("drill")) setSearchParams({}, { replace: true });
  };
  const togglePicking = () => {
    if (isDeck) {
      player.stop();
      setDeckDrilling((v) => !v);
      return;
    }
    if (picking) {
      stopPicking();
      return;
    }
    player.stop();
    setEditing(false);
    setPicking({});
  };
  /** A suggested section: pick its phrases and bring them into view. */
  const chooseSuggestion = (s: { first: number; last: number; title: string }) => {
    setPicking(s);
    setSuggesting(false);
    listRef.current?.querySelector<HTMLElement>(`[data-i="${s.first}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="page practice">
      <header className="topbar">
        <Link to="/" className="btn ghost icon" aria-label="Back" onClick={() => player.stop()}>
          ‹
        </Link>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{episode.title}</h1>
          <div className="sub">
            {!online && <span className="pill busy" style={{ marginRight: 6 }}>Offline</span>}
            {languageLabel(language)} · {segments.length} {isDeck ? "cards" : "phrases"}
            {segDoc.source === "transcript" && segDoc.matchRatio !== undefined
              ? ` · transcript ${Math.round(segDoc.matchRatio * 100)}% matched`
              : ""}
          </div>
        </div>
        {language !== "auto" && (
          <button
            className={`btn small ${picking || deckDrilling ? "primary" : ""}`}
            onClick={togglePicking}
            title={isDeck ? "Learn to say the cards from their English" : "Choose an excerpt to learn to say from its English"}
          >
            Drill
          </button>
        )}
        {!isDeck && (
          <button
            className={`btn small ${editing ? "primary" : ""}`}
            onClick={() => {
              setPicking(null);
              setEditing((v) => !v);
            }}
          >
            {editing ? "Done" : "Edit"}
          </button>
        )}
        <button className="btn ghost icon" aria-label="Settings" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
      </header>

      <div className="transcript" ref={listRef}>
        {segments.map((s, i) => {
          const mark = marks.get(i);
          return (
            <Fragment key={s.id}>
              {mark?.first && <PassageLabel mark={mark} />}
              <div className="seg-row">
                <button
                  data-i={i}
                  className={`seg ${i === player.index && !picking ? "current" : ""} ${i < player.index ? "done" : ""} ${
                    mark ? `in-drill st-${mark.stage} ${mark.due ? "drill-due" : ""}` : ""
                  } ${isPicked(i) ? "picked" : ""}`}
                  onClick={() => (picking ? pick(i) : editing ? player.select(i) : player.playSegment(i))}
                >
                  <span className="t">{formatTime(s.start)}</span>
                  {s.text}
                  {(() => {
                    const p = study.phraseAt(i);
                    return p && study.shownNotes(p).length > 0 ? <span className="note-dot" aria-label="Has notes" /> : null;
                  })()}
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
              {mark?.learnedTo && <div className="learned-line">learned up to here</div>}
            </Fragment>
          );
        })}
      </div>

      <div className="dock">
        {deckDrilling ? (
          <DeckDrill
            uid={uid}
            episode={episode}
            language={language}
            segments={segments}
            drill={episodeDrills.find((d) => d.kind === "cards")}
            onClose={() => setDeckDrilling(false)}
          />
        ) : picking ? (
          <ExcerptPicker
            uid={uid}
            episode={episode}
            language={language}
            segments={segments}
            first={picking.first}
            last={picking.last}
            title={picking.title}
            existing={episodeDrills}
            suggestions={suggestions?.sections.length ?? 0}
            onSuggest={() => setSuggesting(true)}
            onClose={stopPicking}
          />
        ) : (
          <>
            {notice && (
              <p className="small error" onClick={() => setNotice(undefined)}>
                {notice}
              </p>
            )}
            {player.error && <p className="small error">{player.error}</p>}
            <div className={`phrase ${player.phase === "gap" ? "gap" : ""}`}>
              {current ? current.text : "—"}
            </div>
            {settings.showTranslation && (currentStudy?.translation ?? current?.english) && (
              <div className="translation">{currentStudy?.translation ?? current?.english}</div>
            )}
            <div className="progress">
              <div style={{ width: `${Math.round(player.progress * 100)}%` }} />
            </div>
            <div className="row small muted" style={{ justifyContent: "space-between" }}>
              <span>
                {player.index + 1} / {segments.length}
                {settings.mode === "auto" && repeats > 1 && (
                  <span className="muted"> · play {Math.min(player.plays + 1, repeats)} of {repeats}</span>
                )}
              </span>
              <span>
                {player.phase === "gap"
                  ? "your turn…"
                  : player.phase === "clip"
                    ? "English…"
                    : current
                      ? `${(current.end - current.start).toFixed(1)}s`
                      : ""}
              </span>
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
              {settings.mode === "auto" && (
                <select
                  className="input"
                  style={{ width: "auto", padding: "4px 8px", minHeight: 32 }}
                  value={repeats}
                  onChange={(e) => setSettings((s) => ({ ...s, repeats: Number(e.target.value) }))}
                  aria-label="Repeats per phrase"
                  title="How many times each phrase plays before moving on"
                >
                  {(REPEAT_PRESETS.includes(repeats as (typeof REPEAT_PRESETS)[number])
                    ? REPEAT_PRESETS
                    : [...REPEAT_PRESETS, repeats].sort((a, b) => a - b)
                  ).map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? "once" : `${n}× each`}
                    </option>
                  ))}
                </select>
              )}
              {study.enabled && (
                <button className="btn small" disabled={!currentStudy} onClick={openStudy} title="Translation, notes and questions">
                  Study{currentStudy && study.shownNotes(currentStudy).length > 0 ? ` · ${study.shownNotes(currentStudy).length}` : ""}
                </button>
              )}
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
          </>
        )}
      </div>

      {suggesting && (
        <ExcerptSuggestionsSheet
          uid={uid}
          episode={episode}
          language={language}
          segments={segments}
          existing={episodeDrills}
          onChoose={chooseSuggestion}
          onClose={() => setSuggesting(false)}
        />
      )}

      {sheetPhrase && (
        <PhraseStudySheet
          uid={uid}
          episodeId={episode.id}
          language={language}
          phrase={sheetPhrase}
          known={study.known}
          onClose={() => setStudyIndex(undefined)}
        />
      )}

      {showSettings && (
        <SettingsSheet
          uid={uid}
          settings={settings}
          segDoc={segDoc}
          episode={episode}
          language={language}
          study={study}
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
  uid: string;
  settings: PracticeSettings;
  segDoc: SegmentsDoc;
  episode: Episode;
  language: string;
  study: Study;
  modeLabel: string;
  busy?: string;
  onChange: (s: PracticeSettings) => void;
  onClose: () => void;
  onRegenerate: (maxPhraseSec: number) => void;
  onAttachTranscript: (text: string) => void;
}) {
  const { settings, onChange } = props;
  const repeats = clampRepeats(settings.repeats);
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
        <div className="slider">
          <div className="row">
            <span>Repeats per phrase (Auto-advance)</span>
            <span className="muted">{repeats === 1 ? "once" : `${repeats}×`}</span>
          </div>
          <input type="range" min={1} max={MAX_REPEATS} step={1} value={repeats} onChange={(e) => set({ repeats: Number(e.target.value) })} />
          <div className="row" style={{ marginTop: 4, justifyContent: "flex-start" }}>
            {REPEAT_PRESETS.map((n) => (
              <button key={n} className={`btn small ${repeats === n ? "active" : ""}`} onClick={() => set({ repeats: n })}>
                {n}×
              </button>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 4 }}>
            In Auto mode each phrase plays this many times, with a pause after each, before moving to the next one.
          </p>
        </div>

        {props.episode.kind !== "deck" && (
          <>
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
          </>
        )}

        <hr />
        <h2>Study</h2>
        <StudySection
          uid={props.uid}
          episode={props.episode}
          language={props.language}
          study={props.study}
          settings={settings}
          onChange={set}
        />

        <hr />
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span>Offline copy</span>
          <OfflineButton uid={props.uid} episode={props.episode} />
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>
          Saves the audio and word timings on this device so the episode plays without a connection.
        </p>

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
