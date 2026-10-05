import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PhraseStudySheet } from "../components/PhraseStudySheet";
import { playedSeconds, useDrillPlayer, type DrillAudioOptions } from "../hooks/useDrillPlayer";
import { useDrillStudy } from "../hooks/useDrillStudy";
import { useNow } from "../hooks/useDrills";
import { synthesizeAll } from "../lib/drill/clips";
import { bookedByDay, spreadReviews } from "../lib/drill/forecast";
import { CUE_LABEL, REVIEW_LABEL, formatDay, formatMinutes, formatNext } from "../lib/drill/labels";
import { frontier } from "../lib/drill/plan";
import { prefetchDrillEnglish } from "../lib/drill/prefetch";
import { prepareSession, type Prepared } from "../lib/drill/prepare";
import { DrillSession, type Block, type LearnBlock, type SessionEvent } from "../lib/drill/session";
import { learnedPassage, reviewedPassage } from "../lib/drill/srs";
import { cueSize, type DrillOptions, type SessionPhrase, type Step } from "../lib/drill/steps";
import { scheduleLabel } from "../lib/drill/schedules";
import { saveDrillProgress, startSessionLog, updateSessionLog } from "../lib/drill/store";
import { formatTime } from "../lib/format";
import { languageLabel } from "../lib/languages";
import { prepareStudy } from "../lib/study";
import { isVoiceStored, loadVoice } from "../lib/tts/client";
import type { Drill, DrillSchedule, DrillSessionLog } from "../types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Tally = Pick<DrillSessionLog, "reviewed" | "passed" | "learnedPhrases"> & { learnedPassages: number; learnedCards: number };

/** Saves each passage's result as the session reports it, and keeps the session log up to date. */
class Recorder {
  readonly tally: Tally = { reviewed: 0, passed: 0, learnedPhrases: 0, learnedPassages: 0, learnedCards: 0 };
  private logId: string | null = null;
  /** All the schedule's excerpts, as they stand. */
  private readonly drills: Map<string, Drill>;
  private readonly uid: string;
  private readonly language: string;
  private readonly key: string;
  private readonly schedule: DrillSchedule;
  private readonly opts: DrillOptions;
  private readonly onTally: (t: Tally) => void;

  constructor(uid: string, prepared: Prepared, onTally: (t: Tally) => void) {
    this.uid = uid;
    this.language = prepared.language;
    this.key = prepared.key;
    this.drills = new Map(prepared.drills.map((d) => [d.id, d]));
    this.schedule = prepared.schedule;
    this.opts = prepared.opts;
    this.onTally = onTally;
  }

  start() {
    this.logId ??= startSessionLog(this.uid, this.language, this.key, Date.now());
  }

  /** Marks the session as still going (or just ended) now. */
  touch() {
    if (this.logId) updateSessionLog(this.uid, this.logId, Date.now());
  }

  event(e: SessionEvent) {
    const now = Date.now();
    const d = this.drills.get(e.block.drillId);
    if (!d) return;
    if (e.block.cards) {
      this.cardsEvent(d, e, now);
      return;
    }
    const i = e.block.passage;
    const passages = [...d.passages];
    let next: Drill;
    const add: Partial<DrillSessionLog> = { progress: 1 };
    if (e.kind === "reviewed") {
      // A long gap's next review may move a day or more onto a lighter one.
      const others = [...this.drills.values()].flatMap((x) => x.passages.filter((_, j) => x.id !== d.id || j !== i));
      const booked = bookedByDay(others, this.schedule, now, this.opts);
      const spread = spreadReviews(booked, this.schedule, passages[i].end - passages[i].start, this.opts);
      passages[i] = reviewedPassage(passages[i], e.passed, now, spread);
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
    this.save(next, add, now);
  }

  /** A set of cards: each card reviewed or learned on its own account. */
  private cardsEvent(d: Drill, e: SessionEvent, now: number) {
    const cards = e.block.cards!;
    const passages = [...d.passages];
    const add: Partial<DrillSessionLog> = { progress: cards.length };
    if (e.kind === "reviewed") {
      const others = [...this.drills.values()].flatMap((x) => x.passages.filter((_, j) => x.id !== d.id || !cards.includes(j)));
      const booked = bookedByDay(others, this.schedule, now, this.opts);
      let passed = 0;
      cards.forEach((i, k) => {
        const ok = !e.missed.includes(k);
        const spread = spreadReviews(booked, this.schedule, passages[i].end - passages[i].start, this.opts, true);
        passages[i] = reviewedPassage(passages[i], ok, now, spread);
        if (ok) passed++;
      });
      add.reviewed = cards.length;
      add.passed = passed;
      this.tally.reviewed += cards.length;
      this.tally.passed += passed;
    } else if (e.kind === "learned") {
      for (const i of cards) passages[i] = learnedPassage(passages[i], now);
      add.learnedPhrases = cards.length;
      add.learnedSeconds = Math.round(cards.reduce((sum, i) => sum + passages[i].end - passages[i].start, 0));
      this.tally.learnedCards += cards.length;
    } else return;
    this.save({ ...d, passages }, add, now);
  }

  private save(next: Drill, add: Partial<DrillSessionLog>, now: number) {
    this.drills.set(next.id, next);
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
  const { schedule = "" } = useParams();
  return <SessionLoader key={schedule} uid={uid} scheduleKey={schedule} />;
}

function SessionLoader({ uid, scheduleKey }: { uid: string; scheduleKey: string }) {
  const [prepared, setPrepared] = useState<Prepared>();
  const [error, setError] = useState<string>();
  /** Start a new passage even though its reviews won't fit in the coming week. */
  const [learnAnyway, setLearnAnyway] = useState(false);
  useEffect(() => {
    let cancelled = false;
    prepareSession(uid, scheduleKey, Date.now(), { learnAnyway }).then(
      (p) => !cancelled && setPrepared(p),
      (e) => !cancelled && setError(message(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [uid, scheduleKey, learnAnyway]);

  const title = prepared ? `${scheduleLabel(prepared.key, prepared.schedule)} drill` : "Drill";
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
  return (
    <SessionView
      key={String(learnAnyway)}
      uid={uid}
      prepared={prepared}
      onLearnAnyway={() => {
        setPrepared(undefined);
        setLearnAnyway(true);
      }}
    />
  );
}

/** Why the plan has no new passage, when its reviews wouldn't fit (see planSession), with a way past it. */
function HeldBack({ prepared, now, onLearnAnyway }: { prepared: Prepared; now: number; onLearnAnyway: () => void }) {
  const day = prepared.plan.heldBack;
  if (!day) return null;
  const when = formatDay(day.day, now);
  return (
    <div className="drill-notice small">
      New passages are on hold: one more would overfill {when === "today" ? "today's later" : `${when}'s`}{" "}
      {day.sessions > 1 ? "sessions" : "session"}, which already {day.sessions > 1 ? "have" : "has"} about{" "}
      {formatMinutes(day.reviewSec)} of reviews in {formatMinutes(day.capacitySec)}.{" "}
      <button className="btn small" onClick={onLearnAnyway}>
        Learn one anyway
      </button>
    </div>
  );
}

/** The phrase of a span playing at time `t`. */
function phraseAt(phrases: SessionPhrase[], t: number): SessionPhrase {
  let found = phrases[0];
  for (const p of phrases) if (p.start - 0.15 <= t) found = p;
  return found;
}

/**
 * The phrases whose text a step shows: the one playing in a span, or the run of the block's
 * phrases (lead-in included) that makes up the step's text. None while the text is hidden.
 */
function shownPhrases(block: Block, step: Step, position: number): SessionPhrase[] {
  if (step.phrases) return [phraseAt(step.phrases, position)];
  if (!step.text) return [];
  const ps = block.leadIn ? [block.leadIn, ...block.phrases] : block.phrases;
  for (let i = 0; i < ps.length; i++) {
    let text = "";
    for (let j = i; j < ps.length && text.length < step.text.length; j++) {
      text = text ? `${text} ${ps[j].text}` : ps[j].text;
      if (text === step.text) return ps.slice(i, j + 1);
    }
  }
  return [];
}

function SessionView(props: { uid: string; prepared: Prepared; onLearnAnyway: () => void }) {
  const { uid, prepared } = props;
  const { plan, opts, language } = prepared;
  const title = `${scheduleLabel(prepared.key, prepared.schedule)} drill`;
  const voiceId = prepared.voice;
  const needsVoice = prepared.english.length > 0;
  const [voiceReady, setVoiceReady] = useState<boolean>();
  const [download, setDownload] = useState<{ loaded: number; total: number }>();
  const [clips, setClips] = useState<Map<string, AudioBuffer> | undefined>(() => (needsVoice ? undefined : new Map()));
  const [made, setMade] = useState(0);
  const [note, setNote] = useState<string>();
  const [tally, setTally] = useState<Tally>({ reviewed: 0, passed: 0, learnedPhrases: 0, learnedPassages: 0, learnedCards: 0 });
  const [recorder] = useState(() => new Recorder(uid, prepared, setTally));

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
      const episodeIds = new Set(prepared.drills.filter((x) => ids.has(x.id)).map((d) => d.episodeId));
      for (const id of episodeIds) await prepareStudy(id, language, true);
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

  // Study notes for the phrase on screen. The last phrase shown stays on offer while the next
  // one's English plays, so opening notes never gives away an answer.
  const episodeIds = useMemo(() => plan.blocks.map((b) => b.episodeId), [plan]);
  const study = useDrillStudy(uid, language, episodeIds);
  const [onScreen, setOnScreen] = useState<{ episodeId: string; texts: string[] }>();
  const shown = player.current ? shownPhrases(player.current.block, player.current.step, player.position) : [];
  const shownEpisode = player.current?.block.episodeId;
  if (
    shown.length > 0 &&
    shownEpisode &&
    (onScreen?.episodeId !== shownEpisode || onScreen.texts.join("\n") !== shown.map((p) => p.text).join("\n"))
  ) {
    setOnScreen({ episodeId: shownEpisode, texts: shown.map((p) => p.text) });
  }
  const withNotes = (onScreen?.texts ?? []).flatMap((t) => {
    const p = study.withNotes(t);
    return p ? [p] : [];
  });
  /** The phrase whose notes are open, and whether to carry on playing after. */
  const [notesOpen, setNotesOpen] = useState<{ episodeId: string; text: string; resume: boolean }>();
  const notesPhrase = notesOpen && study.phraseFor(notesOpen.text);
  const openNotes = (text: string) => {
    const resume = player.state === "playing";
    if (resume) player.pause();
    setNotesOpen({ episodeId: onScreen!.episodeId, text, resume });
  };
  const closeNotes = () => {
    if (notesOpen?.resume) player.play();
    setNotesOpen(undefined);
  };

  const start = () => {
    recorder.start();
    player.play();
  };

  useEffect(() => {
    if (player.state === "paused" || player.state === "finished") recorder.touch();
  }, [player.state, recorder]);

  // Once the session is over, get the English for the next one ready while the app is still open.
  useEffect(() => {
    if (player.state !== "finished") return;
    let cancelled = false;
    void prefetchDrillEnglish(uid, [prepared.key], voiceId, () => cancelled, true);
    return () => {
      cancelled = true;
    };
  }, [player.state, uid, prepared.key, voiceId]);
  useEffect(() => () => recorder.touch(), [recorder]);

  // Lock screen: what to do now.
  const cur = player.current;
  useEffect(() => {
    if (!("mediaSession" in navigator) || !cur || !started) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: cur.step.label ?? cur.step.text ?? cur.step.english ?? CUE_LABEL[cur.step.cue],
        artist: cur.step.label ? "Drill" : CUE_LABEL[cur.step.cue],
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
      if (document.querySelector(".sheet")) return; // the notes sheet is open
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
  const reviews = plan.blocks.filter((b) => b.kind === "review" && !b.cards).length;
  const cardReviews = plan.blocks.reduce((n, b) => n + (b.kind === "review" && b.cards ? b.cards.length : 0), 0);
  const learning = plan.blocks.filter((b): b is LearnBlock => b.kind === "learn" && !b.cards);
  // New cards by deck: "5 new cards from Sentence deck".
  const newCards = new Map<string, number>();
  for (const b of plan.blocks) {
    if (b.kind === "learn" && b.cards) newCards.set(b.title, (newCards.get(b.title) ?? 0) + b.cards.length);
  }

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
        {started && <span className="small muted">{formatTime(playedSeconds(player.clock, now))}</span>}
      </header>

      {player.state === "finished" ? (
        <div className="center drill-done">
          <h2>Session done</h2>
          <p>
            {tally.reviewed > 0 && `${tally.reviewed} reviewed, ${tally.passed} passed. `}
            {tally.learnedPhrases > 0 && `${tally.learnedPhrases} new ${tally.learnedPhrases === 1 ? "phrase" : "phrases"}. `}
            {tally.learnedPassages > 0 && `${tally.learnedPassages} ${tally.learnedPassages === 1 ? "passage" : "passages"} learned. `}
            {tally.learnedCards > 0 && `${tally.learnedCards} new ${tally.learnedCards === 1 ? "card" : "cards"}.`}
          </p>
          <Link to="/" className="btn primary">
            Back to the library
          </Link>
        </div>
      ) : started && cur ? (
        <>
          <div className="drill-stage">
            {player.action && (
              <div key={player.action.id} className={`drill-toast ${player.action.kind}`} role="status">
                {player.action.kind === "missed"
                  ? `✗ Missed${player.action.late ? " (the one before)" : ""}: ${player.action.text}`
                  : "Skipped ›"}
              </div>
            )}
            <div className="drill-block small muted">
              {cur.block.cards ? (
                <>
                  {cur.block.kind === "review" ? "Reviewing cards" : "New cards"} · {cur.block.title} · {cur.unitIndex + 1} of{" "}
                  {cur.unitCount}
                </>
              ) : (
                <>
                  {cur.block.kind === "review" ? REVIEW_LABEL[cueSize(cur.block.level)] : "Learning"} · {cur.block.title} · passage{" "}
                  {cur.block.passage + 1} of {cur.block.passageCount}
                </>
              )}
              {cur.block.passageTitle && <div className="drill-passage-title">{cur.block.passageTitle}</div>}
            </div>
            <div className={`drill-cue cue-${cur.step.cue}`}>{cur.step.label ?? CUE_LABEL[cur.step.cue]}</div>
            <div className="drill-english">{cur.step.english ?? ""}</div>
            <div className="drill-text">{cur.step.phrases ? phraseAt(cur.step.phrases, player.position).text : (cur.step.text ?? "")}</div>
            <div className="drill-notes">
              {withNotes.map((p) => (
                <button key={p.key} className="btn small" onClick={() => openNotes(p.text)}>
                  {withNotes.length > 1 ? `Notes: ${p.text.length > 24 ? `${p.text.slice(0, 22)}…` : p.text}` : "Study notes"}
                </button>
              ))}
            </div>
          </div>
          {notesPhrase && (
            <PhraseStudySheet
              uid={uid}
              episodeId={notesOpen.episodeId}
              language={language}
              phrase={notesPhrase}
              known={study.known}
              onClose={closeNotes}
            />
          )}
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
              {prepared.schedule.name ? "Nothing on this schedule yet" : `No ${languageLabel(language)} excerpt yet`}. Open an episode,
              tap <b>Drill</b> and choose the stretch you want to learn to say
              {prepared.schedule.name ? ", or move an excerpt here under Drill schedules" : ""}.
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
          <HeldBack prepared={prepared} now={now} onLearnAnyway={props.onLearnAnyway} />
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
            {cardReviews > 0 && (
              <li>
                Review {cardReviews} {cardReviews === 1 ? "card" : "cards"}
                {reviews === 0 && plan.deferred > 0 && <span className="muted"> ({plan.deferred} more wait for a later session)</span>}
              </li>
            )}
            {[...newCards].map(([what, n]) => (
              <li key={what}>
                Learn {n} new {n === 1 ? "card" : "cards"} from {what}
              </li>
            ))}
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

          <HeldBack prepared={prepared} now={now} onLearnAnyway={props.onLearnAnyway} />
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
