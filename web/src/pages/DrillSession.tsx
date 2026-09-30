import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useDrillPlayer, type DrillAudioOptions } from "../hooks/useDrillPlayer";
import { useNow } from "../hooks/useDrills";
import { synthesizeAll } from "../lib/drill/clips";
import { CUE_LABEL, formatMinutes, formatNext } from "../lib/drill/labels";
import { frontier } from "../lib/drill/plan";
import { prefetchDrillEnglish } from "../lib/drill/prefetch";
import { prepareSession, type Prepared } from "../lib/drill/prepare";
import { DrillSession, type SessionEvent } from "../lib/drill/session";
import { learnedPassage, reviewedPassage } from "../lib/drill/srs";
import type { SessionPhrase } from "../lib/drill/steps";
import { prepareDrillStudy, saveDrillProgress, startSessionLog, updateSessionLog } from "../lib/drill/store";
import { formatTime } from "../lib/format";
import { languageLabel } from "../lib/languages";
import { isVoiceStored, loadVoice } from "../lib/tts/client";
import type { Drill, DrillSessionLog } from "../types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Tally = Pick<DrillSessionLog, "reviewed" | "passed" | "learnedPhrases"> & { learnedPassages: number };

/** Saves each passage's result as the session reports it, and keeps the session log up to date. */
class Recorder {
  readonly tally: Tally = { reviewed: 0, passed: 0, learnedPhrases: 0, learnedPassages: 0 };
  private logId: string | null = null;
  private readonly drills: Map<string, Drill>;
  private readonly uid: string;
  private readonly language: string;
  private readonly onTally: (t: Tally) => void;

  constructor(uid: string, language: string, drills: Drill[], onTally: (t: Tally) => void) {
    this.uid = uid;
    this.language = language;
    this.drills = new Map(drills.map((d) => [d.id, d]));
    this.onTally = onTally;
  }

  start() {
    this.logId ??= startSessionLog(this.uid, this.language, Date.now());
  }

  /** Marks the session as still going (or just ended) now. */
  touch() {
    if (this.logId) updateSessionLog(this.uid, this.logId, Date.now());
  }

  event(e: SessionEvent) {
    const now = Date.now();
    const d = this.drills.get(e.block.drillId);
    if (!d) return;
    const i = e.block.passage;
    const passages = [...d.passages];
    let next: Drill;
    const add: Partial<DrillSessionLog> = { progress: 1 };
    if (e.kind === "reviewed") {
      passages[i] = reviewedPassage(passages[i], e.passed, now);
      next = { ...d, passages };
      add.reviewed = 1;
      add.passed = e.passed ? 1 : 0;
      this.tally.reviewed++;
      if (e.passed) this.tally.passed++;
    } else if (e.kind === "learning") {
      next = { ...d, learning: { passage: i, phrases: e.phrases } };
      add.learnedPhrases = 1;
      this.tally.learnedPhrases++;
    } else {
      passages[i] = learnedPassage(passages[i], now);
      next = { ...d, passages, learning: null };
      add.learnedSeconds = Math.round(passages[i].end - passages[i].start);
      this.tally.learnedPassages++;
    }
    this.drills.set(d.id, next);
    saveDrillProgress(this.uid, next);
    if (this.logId) updateSessionLog(this.uid, this.logId, now, add);
    this.onTally({ ...this.tally });
  }
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="page drill">
      <header className="topbar">
        <Link to="/" className="btn ghost icon" aria-label="Back">
          ‹
        </Link>
        <h1>{title}</h1>
      </header>
      {children}
    </div>
  );
}

export default function DrillSessionPage({ uid }: { uid: string }) {
  const { language = "" } = useParams();
  return <SessionLoader key={language} uid={uid} language={language} />;
}

function SessionLoader({ uid, language }: { uid: string; language: string }) {
  const [prepared, setPrepared] = useState<Prepared>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    prepareSession(uid, language, Date.now()).then(
      (p) => !cancelled && setPrepared(p),
      (e) => !cancelled && setError(message(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [uid, language]);

  const title = `${languageLabel(language)} drill`;
  if (error) {
    return (
      <Shell title={title}>
        <p className="error section">{error}</p>
      </Shell>
    );
  }
  if (!prepared) {
    return (
      <Shell title={title}>
        <div className="center">
          <div className="spinner" />
          <p className="muted">Planning the session…</p>
        </div>
      </Shell>
    );
  }
  return <SessionView uid={uid} language={language} prepared={prepared} />;
}

/** The phrase of a span playing at time `t`. */
function phraseAt(phrases: SessionPhrase[], t: number): SessionPhrase {
  let found = phrases[0];
  for (const p of phrases) if (p.start - 0.15 <= t) found = p;
  return found;
}

function SessionView({ uid, language, prepared }: { uid: string; language: string; prepared: Prepared }) {
  const { plan, opts } = prepared;
  const title = `${languageLabel(language)} drill`;
  const voiceId = prepared.voice;
  const needsVoice = prepared.english.length > 0;
  const [voiceReady, setVoiceReady] = useState<boolean>();
  const [download, setDownload] = useState<{ loaded: number; total: number }>();
  const [clips, setClips] = useState<Map<string, AudioBuffer> | undefined>(() => (needsVoice ? undefined : new Map()));
  const [made, setMade] = useState(0);
  const [note, setNote] = useState<string>();
  const [tally, setTally] = useState<Tally>({ reviewed: 0, passed: 0, learnedPhrases: 0, learnedPassages: 0 });
  const [recorder] = useState(() => new Recorder(uid, language, prepared.drills, setTally));
  const [startedAt, setStartedAt] = useState<number>();

  useEffect(() => {
    if (!needsVoice) return;
    let cancelled = false;
    void isVoiceStored(voiceId).then((ok) => !cancelled && setVoiceReady(ok));
    return () => {
      cancelled = true;
    };
  }, [needsVoice, voiceId]);

  // Synthesise all the English before the session starts, while the screen is on.
  useEffect(() => {
    if (!voiceReady || clips) return;
    let cancelled = false;
    void synthesizeAll(voiceId, prepared.english, (done) => !cancelled && setMade(done), () => cancelled).then(
      (m) => !cancelled && setClips(m),
    );
    return () => {
      cancelled = true;
    };
  }, [voiceReady, clips, voiceId, prepared.english]);

  const fetchVoice = async () => {
    setNote(undefined);
    setDownload({ loaded: 0, total: 0 });
    try {
      await loadVoice(voiceId, (loaded, total) => setDownload({ loaded, total }));
      setVoiceReady(true);
    } catch (e) {
      setNote(message(e));
    } finally {
      setDownload(undefined);
    }
  };

  const requestTranslations = async () => {
    setNote("Requesting translations…");
    try {
      const ids = new Set(plan.blocks.map((b) => b.drillId));
      for (const d of prepared.drills.filter((x) => ids.has(x.id))) {
        await prepareDrillStudy({ episodeId: d.episodeId, language, start: d.start, end: d.end });
      }
      setNote("Requested. Translations take a minute or two; open the session again after that.");
    } catch (e) {
      setNote(message(e));
    }
  };

  const session = useMemo(
    () => (clips ? new DrillSession(plan.blocks, opts, (e) => recorder.event(e)) : null),
    [clips, plan, opts, recorder],
  );
  const audioOpts = useMemo<DrillAudioOptions | null>(
    () => (clips ? { sources: prepared.sources, clips, paddingSec: opts.paddingSec } : null),
    [clips, prepared.sources, opts.paddingSec],
  );
  const player = useDrillPlayer(session, audioOpts);
  const started = player.state !== "idle";

  const start = () => {
    recorder.start();
    setStartedAt((t) => t ?? Date.now());
    player.play();
  };

  useEffect(() => {
    if (player.state === "paused" || player.state === "finished") recorder.touch();
  }, [player.state, recorder]);

  // Once the session is over, get the English for the next one ready while the app is still open.
  useEffect(() => {
    if (player.state !== "finished") return;
    let cancelled = false;
    void prefetchDrillEnglish(uid, [language], voiceId, () => cancelled, true);
    return () => {
      cancelled = true;
    };
  }, [player.state, uid, language, voiceId]);
  useEffect(() => () => recorder.touch(), [recorder]);

  // Lock screen: what to do now.
  const cur = player.current;
  useEffect(() => {
    if (!("mediaSession" in navigator) || !cur || !started) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: cur.step.text ?? cur.step.english ?? CUE_LABEL[cur.step.cue],
        artist: CUE_LABEL[cur.step.cue],
        album: cur.block.passageTitle ? `${cur.block.title}: ${cur.block.passageTitle}` : cur.block.title,
      });
    } catch {
      /* unsupported */
    }
  }, [cur, started]);
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = player.state === "playing" ? "playing" : "paused";
    } catch {
      /* unsupported */
    }
  }, [player.state]);

  // Keyboard (desktop): space play/pause, ← or m missed, → skip.
  useEffect(() => {
    if (!started) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        if (player.state === "playing") player.pause();
        else player.play();
      } else if (e.key === "ArrowLeft" || e.key === "m") player.missed();
      else if (e.key === "ArrowRight") player.skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started, player]);

  const now = useNow(started && player.state === "playing" ? 1000 : 60_000);
  const reviews = plan.blocks.filter((b) => b.kind === "review").length;
  const learning = plan.blocks.filter((b) => b.kind === "learn");

  return (
    <div className="page drill">
      <header className="topbar">
        <Link
          to="/"
          className="btn ghost icon"
          aria-label="Back"
          onClick={(e) => {
            if (player.state === "playing" && !confirm("Stop this session? Everything finished so far is saved.")) e.preventDefault();
          }}
        >
          ‹
        </Link>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{title}</h1>
          {plan.blocks.length > 0 && <div className="sub">About {formatMinutes(plan.seconds)}</div>}
        </div>
        {startedAt !== undefined && <span className="small muted">{formatTime((now - startedAt) / 1000)}</span>}
      </header>

      {player.state === "finished" ? (
        <div className="center drill-done">
          <h2>Session done</h2>
          <p>
            {tally.reviewed > 0 && `${tally.reviewed} reviewed, ${tally.passed} passed. `}
            {tally.learnedPhrases > 0 && `${tally.learnedPhrases} new ${tally.learnedPhrases === 1 ? "phrase" : "phrases"}. `}
            {tally.learnedPassages > 0 && `${tally.learnedPassages} ${tally.learnedPassages === 1 ? "passage" : "passages"} learned.`}
          </p>
          <Link to="/" className="btn primary">
            Back to the library
          </Link>
        </div>
      ) : started && cur ? (
        <>
          <div className="drill-stage">
            <div className="drill-block small muted">
              {cur.block.kind === "review" ? "Review" : "Learning"} · {cur.block.title} · passage {cur.block.passage + 1} of{" "}
              {cur.block.passageCount}
              {cur.block.passageTitle && <div className="drill-passage-title">{cur.block.passageTitle}</div>}
            </div>
            <div className={`drill-cue cue-${cur.step.cue}`}>{CUE_LABEL[cur.step.cue]}</div>
            <div className="drill-english">{cur.step.english ?? ""}</div>
            <div className="drill-text">{cur.step.phrases ? phraseAt(cur.step.phrases, player.position).text : (cur.step.text ?? "")}</div>
          </div>
          <div className="dock">
            <div className="progress">
              <div style={{ width: `${Math.round(((cur.blockIndex + cur.unitIndex / cur.unitCount) / plan.blocks.length) * 100)}%` }} />
            </div>
            {player.error && <p className="small error">{player.error}</p>}
            <div className="controls">
              <button className="btn danger drill-missed" disabled={!player.canMiss} onClick={player.missed}>
                ✗ Missed
              </button>
              <button
                className="btn primary icon big"
                onClick={player.state === "playing" ? player.pause : player.play}
                aria-label="Play or pause"
              >
                {player.state === "playing" ? "⏸" : "▶"}
              </button>
              <button className="btn" onClick={player.skip}>
                Skip ›
              </button>
            </div>
            <p className="small muted" style={{ textAlign: "center" }}>
              Press Missed if you couldn't say it. Lock screen: ⏮ missed, ⏭ skip.
            </p>
          </div>
        </>
      ) : plan.blocks.length === 0 ? (
        <div className="section">
          {prepared.drills.length === 0 ? (
            <p>
              No {languageLabel(language)} excerpt yet. Open an episode, tap <b>Drill</b> and choose the stretch you want to learn to
              say.
            </p>
          ) : (
            <p>
              Nothing to drill right now.
              {prepared.nextDue ? ` The next review is ${formatNext(prepared.nextDue, now)}.` : ""}
              {prepared.drills.every((d) => frontier(d) < 0) && prepared.schedule.newMaterial
                ? " Every excerpt is learned: choose another from an episode to keep going."
                : ""}
            </p>
          )}
          <Link to="/" className="btn" style={{ marginTop: 14 }}>
            Back to the library
          </Link>
        </div>
      ) : (
        <div className="section drill-ready">
          <ul className="drill-plan">
            {reviews > 0 && (
              <li>
                Review {reviews} {reviews === 1 ? "passage" : "passages"}
                {plan.deferred > 0 && <span className="muted"> ({plan.deferred} more wait for a later session)</span>}
              </li>
            )}
            {learning.map((b) => (
              <li key={`${b.drillId}-${b.passage}`}>
                Learn {b.passageTitle ? `“${b.passageTitle}” from ` : ""}
                {b.title}, passage {b.passage + 1} of {b.passageCount}
                <span className="muted">
                  {b.from === b.to ? " (run-through only)" : ` (phrases ${b.from + 1}–${b.to}${b.wrapUp ? " and run-through" : ""})`}
                </span>
              </li>
            ))}
          </ul>

          {prepared.untranslated > 0 && (
            <div className="drill-notice small">
              {prepared.untranslated} {prepared.untranslated === 1 ? "phrase has" : "phrases have"} no English yet, so{" "}
              {prepared.untranslated === 1 ? "it" : "they"} can only be heard and repeated.{" "}
              <button className="btn small" onClick={() => void requestTranslations()}>
                Request translations
              </button>
            </div>
          )}
          {needsVoice && voiceReady === false && (
            <div className="drill-notice small">
              The English is read by a voice on this device, which needs downloading once (about 60 MB).{" "}
              <button className="btn small" disabled={!!download} onClick={() => void fetchVoice()}>
                {download
                  ? download.total
                    ? `Downloading ${Math.round((download.loaded / download.total) * 100)}%…`
                    : "Downloading…"
                  : "Download voice"}
              </button>
            </div>
          )}
          {needsVoice && voiceReady && !clips && (
            <p className="small muted">
              Preparing the English audio… {made} / {prepared.english.length}
            </p>
          )}
          {note && <p className="small muted">{note}</p>}

          <button className="btn primary drill-start" disabled={!clips} onClick={start}>
            Start
          </button>
          <p className="small muted">
            Keeps going with the screen off. When you hear the English, say the original before it plays. If you couldn't, press
            Missed (⏮ on the lock screen or headset) and it gets extra practice.
          </p>
        </div>
      )}
    </div>
  );
}
