import { useCallback, useEffect, useMemo, useState } from "react";
import { createGraph, outputOf, schedule, startOutput, type Graph } from "../lib/audioGraph";
import type { Current, DrillSession } from "../lib/drill/session";
import type { Play } from "../lib/drill/steps";

export type DrillPlayerState = "idle" | "playing" | "paused" | "finished";

/** A press the player confirmed, for the screen to show: Missed (with the phrases marked) or Skip. `id` counts presses. */
export type PlayerAction = { id: number } & ({ kind: "missed"; text: string; late: boolean } | { kind: "skip" });

/** Time the session has spent playing: earlier stretches, plus the current one if it's playing. */
export interface PlayClock {
  playedMs: number;
  /** When the current stretch of playing began; absent while paused. */
  since?: number;
}

/** The session's playing time at `now`, which stands still while paused. */
export function playedSeconds(clock: PlayClock, now: number): number {
  return (clock.playedMs + (clock.since === undefined ? 0 : Math.max(0, now - clock.since))) / 1000;
}

export interface DrillAudioOptions {
  /** Audio URL of each episode the session plays from. */
  sources: Record<string, string>;
  /** Synthesised English, by text. */
  clips: Map<string, AudioBuffer>;
  /** Audio played either side of each phrase. */
  paddingSec: number;
}

interface Listener {
  step: (cur: Current | null) => void;
  position: (sec: number) => void;
  state: (s: DrillPlayerState) => void;
  error: (message: string | undefined) => void;
  action: (a: PlayerAction) => void;
  clock: (c: PlayClock) => void;
}

interface Source {
  el: HTMLAudioElement;
  node: MediaElementAudioSourceNode | null;
  onError: () => void;
}

const MEDIA_ACTIONS: MediaSessionAction[] = ["play", "pause", "stop", "nexttrack", "seekforward", "previoustrack", "seekbackward"];

/**
 * Plays a drill session through the background-playback graph (see audioGraph.ts): episode audio
 * from one <audio> element per episode, English from AudioBuffers, and silences timed on the audio
 * clock, so a session keeps going with the screen off.
 */
class DrillAudio {
  private graph: Graph | null = null;
  private sources = new Map<string, Source>();
  private cancelStep: () => void = () => {};
  private raf = 0;
  private playing = false;
  private presses = 0;
  private clock: PlayClock = { playedMs: 0 };
  private readonly session: DrillSession;
  private readonly opts: DrillAudioOptions;
  private readonly on: Listener;

  constructor(session: DrillSession, opts: DrillAudioOptions, on: Listener) {
    this.session = session;
    this.opts = opts;
    this.on = on;
  }

  /** Starts loading every episode's audio, so the first seek into each is quick. */
  preload() {
    for (const id of Object.keys(this.opts.sources)) this.source(id);
  }

  /** Starts or resumes. Call it from a tap: browsers only start audio in response to one. */
  async play() {
    if (this.playing || this.session.finished) return;
    this.playing = true;
    this.setClock({ playedMs: this.clock.playedMs, since: Date.now() });
    this.on.state("playing");
    this.on.error(undefined);
    await this.startGraph();
    if (!this.playing) return;
    this.bindMediaSession();
    this.runStep();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.stopClock();
    this.stopStep();
    this.graph?.out.pause();
    this.on.state("paused");
  }

  /** Moves on to the next step now. */
  skip() {
    this.chime("skip");
    this.on.action({ id: ++this.presses, kind: "skip" });
    this.stopStep();
    this.session.advance();
    this.runStep();
  }

  /** Marks a test missed (see DrillSession.missed); before the answer, jumps straight to it. */
  missed() {
    const miss = this.session.missed();
    if (!miss) return;
    this.chime("missed");
    this.on.action({ id: ++this.presses, kind: "missed", text: miss.phrases.map((p) => p.text).join(" "), late: miss.late });
    if (miss.jumped && this.playing) {
      this.stopStep();
      this.runStep();
    } else {
      this.on.step(this.session.current());
    }
  }

  /**
   * A short tone confirming a press: two falling notes for Missed, a tick for Skip. It goes through
   * the same output as everything else, so it's heard with the screen off too.
   */
  private chime(kind: "missed" | "skip") {
    const g = this.graph;
    if (!g || g.ctx.state !== "running") return;
    const notes = kind === "missed" ? [523, 392] : [1047];
    const t0 = g.ctx.currentTime + 0.01;
    notes.forEach((freq, i) => {
      const t = t0 + i * 0.13;
      const osc = g.ctx.createOscillator();
      const gain = g.ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(gain);
      gain.connect(outputOf(g));
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
      osc.start(t);
      osc.stop(t + 0.13);
    });
  }

  /** Lock-screen "back": Missed during a test, otherwise the current step again. */
  back() {
    if (this.session.canMiss()) {
      this.missed();
    } else if (this.playing) {
      this.stopStep();
      this.runStep();
    }
  }

  destroy() {
    this.playing = false;
    this.stopClock();
    this.stopStep();
    for (const s of this.sources.values()) {
      s.el.pause();
      s.node?.disconnect();
      s.el.removeEventListener("error", s.onError);
      s.el.removeAttribute("src");
      s.el.load();
    }
    this.sources.clear();
    if (this.graph) {
      this.graph.out.pause();
      this.graph.out.srcObject = null;
      void this.graph.ctx.close();
      this.graph = null;
    }
    if ("mediaSession" in navigator) {
      for (const action of MEDIA_ACTIONS) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          /* unsupported action */
        }
      }
    }
  }

  private setClock(c: PlayClock) {
    this.clock = c;
    this.on.clock(c);
  }

  /** Banks the current stretch of playing time. */
  private stopClock() {
    const { playedMs, since } = this.clock;
    if (since !== undefined) this.setClock({ playedMs: playedMs + Math.max(0, Date.now() - since) });
  }

  private stopStep() {
    cancelAnimationFrame(this.raf);
    this.cancelStep();
    this.cancelStep = () => {};
  }

  /** Shows the current step and, while playing, plays it; each step's end moves the session on. */
  private runStep() {
    const cur = this.session.current();
    this.on.step(cur);
    if (!cur) {
      this.playing = false;
      this.stopClock();
      this.graph?.out.pause();
      this.on.state("finished");
      return;
    }
    if (!this.playing) return;
    const next = () => {
      this.cancelStep = () => {};
      this.session.advance();
      this.runStep();
    };
    const play = cur.step.play;
    if (play.kind === "silence") this.cancelStep = schedule(this.graph, play.sec, next);
    else if (play.kind === "english") this.playClip(play.text, next);
    else this.playSource(play, next);
  }

  private playClip(text: string, next: () => void) {
    const g = this.graph;
    const buffer = this.opts.clips.get(text);
    if (!g || !buffer || g.ctx.state !== "running") {
      // No clip (the voice failed on it): a short pause instead, so the rhythm holds.
      this.cancelStep = schedule(g, 0.5, next);
      return;
    }
    const node = g.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(outputOf(g));
    node.onended = () => {
      node.disconnect();
      next();
    };
    node.start();
    this.cancelStep = () => {
      node.onended = null;
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
      node.disconnect();
    };
  }

  private playSource(play: Extract<Play, { kind: "source" }>, next: () => void) {
    const src = this.source(play.episodeId);
    if (!src) {
      next();
      return;
    }
    const el = src.el;
    const start = Math.max(0, play.start - this.opts.paddingSec);
    const end = play.end + this.opts.paddingSec;
    let over = false;
    let cancelEnd = () => {};
    const stop = () => {
      over = true;
      cancelEnd();
      cancelAnimationFrame(this.raf);
      el.pause();
    };
    const done = () => {
      if (over) return;
      stop();
      next();
    };
    this.cancelStep = stop;

    const begin = async () => {
      if (over) return;
      if (this.graph) this.connect(this.graph, src);
      el.playbackRate = play.rate;
      try {
        el.currentTime = start;
        await el.play();
      } catch (e) {
        if (over) return;
        this.on.error(e instanceof Error ? e.message : String(e));
        this.pause();
        return;
      }
      if (over) {
        el.pause();
        return;
      }
      // The progress display follows animation frames while visible; the end is timed on the
      // audio clock so it still fires with the screen off.
      const tick = () => {
        this.on.position(el.currentTime);
        if (el.currentTime >= end || el.ended) done();
        else this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
      const scheduleEnd = () => {
        cancelEnd();
        const remaining = (end - el.currentTime) / (el.playbackRate || 1);
        cancelEnd = schedule(this.graph, remaining + 0.015, () => {
          if (el.currentTime >= end - 0.03 || el.ended) done();
          else scheduleEnd();
        });
      };
      scheduleEnd();
    };
    if (el.readyState >= 1) void begin();
    else el.addEventListener("loadedmetadata", () => void begin(), { once: true });
  }

  private source(episodeId: string): Source | undefined {
    const have = this.sources.get(episodeId);
    if (have) return have;
    const url = this.opts.sources[episodeId];
    if (!url) return undefined;
    const el = new Audio();
    el.preload = "auto";
    // CORS mode lets the service worker serve saved audio offline and Web Audio read the output.
    el.crossOrigin = "anonymous";
    const onError = () => {
      this.on.error("The episode's audio failed to load.");
      this.pause();
    };
    el.addEventListener("error", onError);
    el.src = url;
    el.load();
    const s: Source = { el, node: null, onError };
    this.sources.set(episodeId, s);
    if (this.graph) this.connect(this.graph, s);
    return s;
  }

  private connect(g: Graph, s: Source) {
    if (s.node) return;
    try {
      s.node = g.ctx.createMediaElementSource(s.el);
      s.node.connect(outputOf(g));
    } catch {
      /* the element plays directly, without the background keep-alive */
    }
  }

  private async startGraph() {
    if (!this.graph) this.graph = createGraph();
    const g = this.graph;
    if (!g) return;
    try {
      if (g.ctx.state !== "running") await g.ctx.resume();
    } catch {
      /* retried on the next play */
    }
    for (const s of this.sources.values()) this.connect(g, s);
    if (g.direct) return;
    try {
      await startOutput(g);
    } catch {
      // The output element refused to play: send audio straight to the speakers instead.
      g.direct = true;
      for (const s of this.sources.values()) {
        s.node?.disconnect();
        s.node?.connect(g.ctx.destination);
      }
    }
  }

  private bindMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const handlers: Record<string, () => void> = {
      play: () => void this.play(),
      pause: () => this.pause(),
      stop: () => this.pause(),
      nexttrack: () => this.skip(),
      seekforward: () => this.skip(),
      previoustrack: () => this.back(),
      seekbackward: () => this.back(),
    };
    for (const action of MEDIA_ACTIONS) {
      try {
        navigator.mediaSession.setActionHandler(action, handlers[action]);
      } catch {
        /* unsupported action */
      }
    }
  }
}

/**
 * Plays a drill session. `opts` must be ready (English synthesised) before playback starts; the
 * player is rebuilt if the session or options change.
 */
export function useDrillPlayer(session: DrillSession | null, opts: DrillAudioOptions | null) {
  const [state, setState] = useState<DrillPlayerState>("idle");
  const [current, setCurrent] = useState<Current | null>(null);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState<string>();
  const [action, setAction] = useState<PlayerAction>();
  const [clock, setClock] = useState<PlayClock>({ playedMs: 0 });

  const audio = useMemo(
    () =>
      session && opts
        ? new DrillAudio(session, opts, {
            step: setCurrent,
            position: setPosition,
            state: setState,
            error: setError,
            action: setAction,
            clock: setClock,
          })
        : null,
    [session, opts],
  );
  // A confirmation shows for a moment.
  useEffect(() => {
    if (!action) return;
    const t = window.setTimeout(() => setAction(undefined), 2000);
    return () => window.clearTimeout(t);
  }, [action]);
  useEffect(() => {
    if (!audio) return;
    audio.preload();
    return () => audio.destroy();
  }, [audio]);

  const shown = current ?? session?.current() ?? null;
  return {
    state,
    current: shown,
    /** Playback time within the episode, for following a span of several phrases. */
    position,
    error,
    /** The last press confirmed, for about two seconds. */
    action,
    /** Time spent playing so far (see playedSeconds). */
    clock,
    canMiss: session?.canMiss() ?? false,
    play: useCallback(() => void audio?.play(), [audio]),
    pause: useCallback(() => audio?.pause(), [audio]),
    skip: useCallback(() => audio?.skip(), [audio]),
    missed: useCallback(() => audio?.missed(), [audio]),
  };
}
