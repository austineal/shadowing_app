import { useCallback, useEffect, useRef, useState } from "react";
import type { PracticeSettings, Segment } from "../types";

export type PlayerPhase = "idle" | "playing" | "gap";

interface Options {
  segments: Segment[];
  settings: PracticeSettings;
  title?: string;
}

/**
 * Background-playback graph.
 *
 * The phrase <audio> element is routed through Web Audio into a MediaStream that a second,
 * never-paused "output" <audio> element plays. To the OS one track is playing continuously,
 * including during the silent gaps between phrases, so the page is not suspended when the
 * screen is off (iOS freezes JS within seconds of audio stopping; Android throttles/freezes
 * background tabs). Timers are scheduled on the audio clock (ConstantSourceNode.onended)
 * rather than setTimeout, which background tabs throttle.
 */
interface Graph {
  ctx: AudioContext;
  dest: MediaStreamAudioDestinationNode;
  out: HTMLAudioElement;
  /** Set when the output element couldn't play; audio goes straight to ctx.destination. */
  direct: boolean;
}

function createGraph(): Graph | null {
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    const ctx = new AC();
    const dest = ctx.createMediaStreamDestination();
    const out = new Audio();
    out.srcObject = dest.stream;
    // iOS 17+: keep playing under the lock screen and with the mute switch on.
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session) {
      try {
        session.type = "playback";
      } catch {
        /* unsupported */
      }
    }
    return { ctx, dest, out, direct: false };
  } catch {
    return null;
  }
}

/** Runs cb after `seconds`, using the audio clock when available. Returns a cancel function. */
function schedule(g: Graph | null, seconds: number, cb: () => void): () => void {
  if (g && g.ctx.state === "running") {
    try {
      const n = g.ctx.createConstantSource();
      n.offset.value = 0; // silent
      n.connect(g.dest);
      n.onended = () => {
        n.disconnect();
        cb();
      };
      n.start();
      n.stop(g.ctx.currentTime + Math.max(0, seconds));
      return () => {
        n.onended = null;
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
        n.disconnect();
      };
    } catch {
      /* fall through to setTimeout */
    }
  }
  const id = window.setTimeout(cb, Math.max(0, seconds * 1000));
  return () => window.clearTimeout(id);
}

/**
 * Drives an <audio> element phrase by phrase.
 * - playSegment(i) seeks to the phrase (minus padding) and plays until its end (plus padding).
 * - In "auto"/"loop" modes, a silent gap proportional to the phrase length follows, then the
 *   next (or same) phrase plays. In "manual" mode playback simply stops.
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
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();

  const stateRef = useRef({ ...opts, index });
  stateRef.current = { ...opts, index };

  const rafRef = useRef(0);
  const cancelEndRef = useRef<() => void>(() => {});
  const cancelGapRef = useRef<() => void>(() => {});

  const clearTimers = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    cancelEndRef.current();
    cancelGapRef.current();
    cancelEndRef.current = () => {};
    cancelGapRef.current = () => {};
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
    if (audioRef.current) audioRef.current.playbackRate = opts.settings.rate;
  }, [opts.settings.rate]);

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
      if (g.out.paused) await g.out.play();
    } catch {
      // Output element refused to play; route audio straight out instead.
      g.direct = true;
      sourceRef.current.disconnect();
      sourceRef.current.connect(g.ctx.destination);
    }
  }, []);

  const api = useRef({
    playSegment: (_i: number) => {},
    finishSegment: () => {},
    stop: () => {},
  });

  api.current.stop = () => {
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
    const seg = segments[i];
    if (!seg || settings.mode === "manual") {
      graphRef.current?.out.pause();
      setPhase("idle");
      setProgress(1);
      return;
    }
    const gapSec = Math.max(0.4, ((seg.end - seg.start) / settings.rate) * settings.gapFactor);
    setPhase("gap");
    setProgress(1);
    cancelGapRef.current = schedule(graphRef.current, gapSec, () => {
      const s = stateRef.current;
      if (s.settings.mode === "loop") api.current.playSegment(s.index);
      else if (s.index + 1 < s.segments.length) api.current.playSegment(s.index + 1);
      else {
        graphRef.current?.out.pause();
        setPhase("idle");
      }
    });
  };

  api.current.playSegment = (i: number) => {
    const a = audioRef.current;
    const { segments, settings } = stateRef.current;
    const seg = segments[i];
    if (!a || !seg) return;
    clearTimers();
    setIndex(i);
    stateRef.current.index = i;
    setProgress(0);

    const pad = settings.paddingMs / 1000;
    const start = Math.max(0, seg.start - pad);
    const end = seg.end + pad;
    a.playbackRate = settings.rate;

    const begin = async () => {
      try {
        await startGraph(a);
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
