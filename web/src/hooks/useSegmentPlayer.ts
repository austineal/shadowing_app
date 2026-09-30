import { useCallback, useEffect, useRef, useState } from "react";
import { createGraph, schedule, startOutput, type Graph } from "../lib/audioGraph";
import { gapSeconds, nextAction, sourceRate, stepsAfterSource, type ClipKind, type FollowStep } from "../lib/sequence";
import type { PracticeSettings, Segment } from "../types";

/** playing: source audio. clip: an extra clip (translation etc.). gap: silence for the user to speak. */
export type PlayerPhase = "idle" | "playing" | "clip" | "gap";

interface Options {
  segments: Segment[];
  settings: PracticeSettings;
  title?: string;
  /**
   * Extra audio for a phrase: the clip, a promise of one still being prepared (waited for up to
   * CLIP_WAIT_SEC), or undefined to skip it.
   */
  getClip?: (index: number, clip: ClipKind) => AudioBuffer | Promise<AudioBuffer | undefined> | undefined;
}

/** How long a clip that is still being generated may hold up playback before it's skipped. */
const CLIP_WAIT_SEC = 8;

/**
 * Drives an <audio> element phrase by phrase.
 * - playSegment(i) seeks to the phrase (minus padding) and plays until its end (plus padding).
 * - The source audio is followed by the steps from stepsAfterSource (extra clips, then a
 *   silent gap proportional to the phrase length), after which nextAction decides whether to
 *   replay, advance or stop. In "auto" mode the same phrase is played `settings.repeats` times
 *   before advancing; "loop" repeats forever; "manual" stops after the phrase.
 * Uses requestAnimationFrame for the progress bar while visible; stopping and gap timing use
 * audio-clock timers so they keep working with the screen off.
 */
export function useSegmentPlayer(audioSrc: string | undefined, opts: Options) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<PlayerPhase>("idle");
  const [progress, setProgress] = useState(0);
  /** Completed plays of the current phrase in this auto-mode pass (resets on any user navigation). */
  const [plays, setPlays] = useState(0);
  const playsRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();

  const stateRef = useRef({ ...opts, index });
  stateRef.current = { ...opts, index };

  const rafRef = useRef(0);
  const cancelEndRef = useRef<() => void>(() => {});
  /** Cancels the running follow step (gap timer or clip). */
  const cancelStepRef = useRef<() => void>(() => {});

  const clearTimers = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    cancelEndRef.current();
    cancelStepRef.current();
    cancelEndRef.current = () => {};
    cancelStepRef.current = () => {};
  }, []);

  // Audio element lifecycle.
  useEffect(() => {
    if (!audioSrc) return;
    const a = new Audio();
    a.preload = "auto";
    // CORS mode lets the service worker serve cached audio (and slice range requests) offline,
    // and is required for Web Audio to read the element's output.
    a.crossOrigin = "anonymous";
    a.src = audioSrc;
    audioRef.current = a;
    setReady(false);
    const onMeta = () => setReady(true);
    const onErr = () => setError("Audio failed to load.");
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("error", onErr);
    a.load();
    return () => {
      clearTimers();
      a.pause();
      sourceRef.current?.disconnect();
      sourceRef.current = null;
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("error", onErr);
      a.removeAttribute("src");
      a.load();
      audioRef.current = null;
    };
  }, [audioSrc, clearTimers]);

  // Tear down the graph on unmount.
  useEffect(() => {
    return () => {
      const g = graphRef.current;
      if (!g) return;
      g.out.pause();
      g.out.srcObject = null;
      void g.ctx.close();
      graphRef.current = null;
    };
  }, []);

  // Live playback-rate changes.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = sourceRate(stateRef.current.settings, playsRef.current + 1);
  }, [opts.settings.rate, opts.settings.slowPlays, opts.settings.slowRate, opts.settings.mode]);

  /** Connects the element to the graph and starts the continuous output stream. */
  const startGraph = useCallback(async (a: HTMLAudioElement) => {
    if (!graphRef.current) graphRef.current = createGraph();
    const g = graphRef.current;
    if (!g) return;
    try {
      if (g.ctx.state !== "running") await g.ctx.resume();
    } catch {
      /* will retry on next play */
    }
    if (!sourceRef.current) {
      try {
        const src = g.ctx.createMediaElementSource(a);
        src.connect(g.direct ? g.ctx.destination : g.dest);
        sourceRef.current = src;
      } catch {
        return; // element plays directly; no background keep-alive
      }
    }
    if (g.direct) return;
    try {
      await startOutput(g);
    } catch {
      // Output element refused to play; route audio straight out instead.
      g.direct = true;
      sourceRef.current.disconnect();
      sourceRef.current.connect(g.ctx.destination);
    }
  }, []);

  /**
   * Bumped by every start and stop, so a start overtaken while the output was starting (which
   * takes a moment the first time; see startOutput) doesn't go on to play.
   */
  const startTokenRef = useRef(0);

  const api = useRef({
    /** keepPlays: true when called by the auto-advance timer, so the repeat count carries over. */
    playSegment: (_i: number, _keepPlays?: boolean) => {},
    /** Called when the phrase's source audio ends. */
    finishSegment: () => {},
    /** Runs steps[k] and the ones after it; `done` is the completed-play count for nextAction. */
    runFollow: (_steps: FollowStep[], _k: number, _done: number) => {},
    afterPlay: (_done: number) => {},
    stop: () => {},
  });

  const setPlayCount = (n: number) => {
    playsRef.current = n;
    setPlays(n);
  };

  api.current.stop = () => {
    startTokenRef.current++;
    clearTimers();
    audioRef.current?.pause();
    graphRef.current?.out.pause();
    setPhase("idle");
  };

  api.current.finishSegment = () => {
    const a = audioRef.current;
    clearTimers();
    a?.pause();
    const { settings, index: i, segments } = stateRef.current;
    setProgress(1);
    if (!segments[i]) {
      graphRef.current?.out.pause();
      setPhase("idle");
      return;
    }
    const playNumber = playsRef.current + 1;
    if (settings.mode !== "manual") setPlayCount(playNumber);
    api.current.runFollow(stepsAfterSource(settings, playNumber), 0, playNumber);
  };

  api.current.runFollow = (steps, k, done) => {
    const step = steps[k];
    if (!step) {
      api.current.afterPlay(done);
      return;
    }
    const advance = () => api.current.runFollow(steps, k + 1, done);
    const { settings, index: i, segments } = stateRef.current;
    if (step.kind === "pause") {
      cancelStepRef.current = schedule(graphRef.current, step.sec, advance);
      return;
    }
    if (step.kind === "gap") {
      setPhase("gap");
      const seg = segments[i];
      cancelStepRef.current = schedule(graphRef.current, seg ? gapSeconds(seg, settings, done) : 0.4, advance);
      return;
    }
    // Clips play through the same graph so the background keep-alive stream carries them,
    // and their end fires on the audio clock like the gap timers.
    const g = graphRef.current;
    const clip = stateRef.current.getClip?.(i, step.clip);
    if (!g || !clip || g.ctx.state !== "running") {
      advance();
      return;
    }
    setPhase("clip");
    const playBuffer = (buffer: AudioBuffer) => {
      const node = g.ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(g.direct ? g.ctx.destination : g.dest);
      node.onended = () => {
        node.disconnect();
        advance();
      };
      node.start();
      cancelStepRef.current = () => {
        node.onended = null;
        try {
          node.stop();
        } catch {
          /* already stopped */
        }
        node.disconnect();
      };
    };
    if (clip instanceof AudioBuffer) {
      playBuffer(clip);
      return;
    }
    // Still being generated. The keep-alive stream keeps the page running while we wait, and the
    // timeout runs on the audio clock so it still fires with the screen off.
    let settled = false;
    const cancelTimeout = schedule(g, CLIP_WAIT_SEC, () => {
      if (settled) return;
      settled = true;
      advance();
    });
    cancelStepRef.current = () => {
      settled = true;
      cancelTimeout();
    };
    const finish = (buffer: AudioBuffer | undefined) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      if (buffer) playBuffer(buffer);
      else advance();
    };
    clip.then(finish, () => finish(undefined));
  };

  api.current.afterPlay = (done) => {
    const s = stateRef.current;
    const action = nextAction(s.settings, done, s.index, s.segments.length);
    if (action.kind === "replay") api.current.playSegment(s.index, action.keepPlays);
    else if (action.kind === "advance") api.current.playSegment(s.index + 1);
    else {
      if (s.settings.mode !== "manual") setPlayCount(0);
      graphRef.current?.out.pause();
      setPhase("idle");
    }
  };

  api.current.playSegment = (i: number, keepPlays = false) => {
    const a = audioRef.current;
    const { segments, settings } = stateRef.current;
    const seg = segments[i];
    if (!a || !seg) return;
    clearTimers();
    setIndex(i);
    stateRef.current.index = i;
    setProgress(0);
    if (!keepPlays) setPlayCount(0);

    const pad = settings.paddingMs / 1000;
    const start = Math.max(0, seg.start - pad);
    const end = seg.end + pad;
    a.playbackRate = sourceRate(settings, playsRef.current + 1);
    const token = ++startTokenRef.current;

    const begin = async () => {
      try {
        await startGraph(a);
        if (startTokenRef.current !== token) return; // stopped or replaced while the output started
        a.currentTime = start;
        await a.play();
      } catch (e) {
        setPhase("idle");
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (audioRef.current !== a) return; // element replaced while starting
      setError(undefined);
      setPhase("playing");

      let lastProgress = -1;
      const tick = () => {
        const t = a.currentTime;
        const p = Math.min(1, Math.max(0, (t - start) / Math.max(0.01, end - start)));
        if (Math.abs(p - lastProgress) > 0.01) {
          lastProgress = p;
          setProgress(p);
        }
        if (t >= end || a.ended) {
          api.current.finishSegment();
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);

      const scheduleEnd = () => {
        cancelEndRef.current();
        const remaining = (end - a.currentTime) / (a.playbackRate || 1);
        cancelEndRef.current = schedule(graphRef.current, remaining + 0.015, () => {
          if (a.paused && a.currentTime < end - 0.05) return; // stopped externally
          if (a.currentTime >= end - 0.03 || a.ended) api.current.finishSegment();
          else scheduleEnd();
        });
      };
      scheduleEnd();
    };

    if (a.readyState >= 1) void begin();
    else a.addEventListener("loadedmetadata", () => void begin(), { once: true });
  };

  // Natural end of the whole file.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onEnded = () => api.current.finishSegment();
    a.addEventListener("ended", onEnded);
    return () => a.removeEventListener("ended", onEnded);
  }, [audioSrc]);

  const playSegment = useCallback((i: number) => api.current.playSegment(i), []);
  const stop = useCallback(() => api.current.stop(), []);
  const select = useCallback((i: number) => {
    api.current.stop();
    setIndex(i);
    stateRef.current.index = i;
    setProgress(0);
    setPlayCount(0);
  }, []);
  const toggle = useCallback(() => {
    if (stateRef.current.index >= stateRef.current.segments.length) return;
    if (phase === "idle") api.current.playSegment(stateRef.current.index);
    else api.current.stop();
  }, [phase]);
  const replay = useCallback(() => api.current.playSegment(stateRef.current.index), []);
  const next = useCallback(() => {
    const s = stateRef.current;
    if (s.index + 1 < s.segments.length) api.current.playSegment(s.index + 1);
  }, []);
  const prev = useCallback(() => {
    const s = stateRef.current;
    if (s.index > 0) api.current.playSegment(s.index - 1);
  }, []);

  // Lock-screen / headset controls.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const seg = opts.segments[index];
    try {
      ms.metadata = new MediaMetadata({
        title: seg?.text.slice(0, 120) || opts.title || "Shadowing",
        artist: opts.title ?? "Shadowing",
        album: `Phrase ${index + 1} of ${opts.segments.length}`,
      });
      ms.setActionHandler("play", () => api.current.playSegment(stateRef.current.index));
      ms.setActionHandler("pause", () => api.current.stop());
      ms.setActionHandler("stop", () => api.current.stop());
      ms.setActionHandler("nexttrack", next);
      ms.setActionHandler("previoustrack", prev);
      ms.setActionHandler("seekforward", next);
      ms.setActionHandler("seekbackward", replay);
    } catch {
      /* unsupported action */
    }
  }, [index, opts.segments, opts.title, next, prev, replay]);

  // Keep the lock-screen state in sync (the output stream is "playing" through the gaps).
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = phase === "idle" ? "paused" : "playing";
    } catch {
      /* unsupported */
    }
  }, [phase]);

  return {
    index,
    phase,
    playing: phase === "playing",
    progress,
    plays,
    ready,
    error,
    playSegment,
    select,
    toggle,
    replay,
    stop,
    next,
    prev,
  };
}
