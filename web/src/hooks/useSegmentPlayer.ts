import { useCallback, useEffect, useRef, useState } from "react";
import type { PracticeSettings, Segment } from "../types";

export type PlayerPhase = "idle" | "playing" | "gap";

interface Options {
  segments: Segment[];
  settings: PracticeSettings;
  title?: string;
}

/**
 * Drives an <audio> element phrase by phrase.
 * - playSegment(i) seeks to the phrase (minus padding) and plays until its end (plus padding).
 * - In "auto"/"loop" modes, a silent gap proportional to the phrase length follows, then the
 *   next (or same) phrase plays. In "manual" mode playback simply stops.
 * Uses requestAnimationFrame for precise stopping while visible and a timer fallback when
 * the screen is off, where rAF is suspended.
 */
export function useSegmentPlayer(audioSrc: string | undefined, opts: Options) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<PlayerPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();

  const stateRef = useRef({ ...opts, index });
  stateRef.current = { ...opts, index };

  const rafRef = useRef(0);
  const endTimerRef = useRef(0);
  const gapTimerRef = useRef(0);

  const clearTimers = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    window.clearTimeout(endTimerRef.current);
    window.clearTimeout(gapTimerRef.current);
  }, []);

  // Audio element lifecycle.
  useEffect(() => {
    if (!audioSrc) return;
    const a = new Audio();
    a.preload = "auto";
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
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("error", onErr);
      a.removeAttribute("src");
      a.load();
      audioRef.current = null;
    };
  }, [audioSrc, clearTimers]);

  // Live playback-rate changes.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = opts.settings.rate;
  }, [opts.settings.rate]);

  const api = useRef({
    playSegment: (_i: number) => {},
    finishSegment: () => {},
    stop: () => {},
  });

  api.current.stop = () => {
    clearTimers();
    audioRef.current?.pause();
    setPhase("idle");
  };

  api.current.finishSegment = () => {
    const a = audioRef.current;
    clearTimers();
    a?.pause();
    const { settings, index: i, segments } = stateRef.current;
    const seg = segments[i];
    if (!seg || settings.mode === "manual") {
      setPhase("idle");
      setProgress(1);
      return;
    }
    const gapMs = Math.max(400, ((seg.end - seg.start) / settings.rate) * settings.gapFactor * 1000);
    setPhase("gap");
    setProgress(1);
    gapTimerRef.current = window.setTimeout(() => {
      const s = stateRef.current;
      if (s.settings.mode === "loop") api.current.playSegment(s.index);
      else if (s.index + 1 < s.segments.length) api.current.playSegment(s.index + 1);
      else setPhase("idle");
    }, gapMs);
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
        a.currentTime = start;
        await a.play();
      } catch (e) {
        setPhase("idle");
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
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
        window.clearTimeout(endTimerRef.current);
        const remainingMs = ((end - a.currentTime) / (a.playbackRate || 1)) * 1000;
        endTimerRef.current = window.setTimeout(() => {
          if (a.paused && a.currentTime < end - 0.05) return; // stopped externally
          if (a.currentTime >= end - 0.03 || a.ended) api.current.finishSegment();
          else scheduleEnd();
        }, Math.max(0, remainingMs) + 15);
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
