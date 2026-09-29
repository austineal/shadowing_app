import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { phraseKey, subscribeEpisodePhrases } from "../lib/study";
import { isVoiceStored, synthesize } from "../lib/tts/client";
import type { ClipKind } from "../lib/sequence";
import type { Episode, PhraseStudy, Segment } from "../types";

/** How many phrases ahead of the current one to prepare English audio for. */
const PREFETCH_AHEAD = 3;
/** Generated clips kept in memory. */
const MAX_CLIPS = 60;

/**
 * Study material for the episode's phrases, plus English translation clips generated on this
 * device with `voiceId` (once that voice has been downloaded). `language` must be a concrete code.
 */
export function useStudy(uid: string, episode: Episode, segments: Segment[], language: string, voiceId: string) {
  const enabled = !!episode.study?.enabled && language !== "auto";

  /** Phrase key for each segment index. */
  const [keys, setKeys] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void Promise.all(segments.map((s) => phraseKey(language, s.text))).then((k) => !cancelled && setKeys(k));
    return () => {
      cancelled = true;
    };
  }, [enabled, segments, language]);

  const [phrases, setPhrases] = useState<Map<string, PhraseStudy>>(new Map());
  useEffect(() => {
    if (!enabled) return;
    return subscribeEpisodePhrases(uid, episode.id, setPhrases);
  }, [enabled, uid, episode.id]);

  const phraseAt = useCallback(
    (i: number): PhraseStudy | undefined => (enabled ? phrases.get(keys[i]) : undefined),
    [enabled, phrases, keys],
  );

  const progress = useMemo(() => {
    const unique = new Set(keys);
    const level = episode.study?.level;
    let done = 0;
    for (const k of unique) if (phrases.get(k)?.level === level) done++;
    return { total: unique.size, done };
  }, [keys, phrases, episode.study?.level]);

  /** Whether the English voice's model is on this device. */
  const [voiceReady, setVoiceReady] = useState(false);
  const [voiceCheck, setVoiceCheck] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void isVoiceStored(voiceId).then((ok) => !cancelled && setVoiceReady(ok));
    return () => {
      cancelled = true;
    };
  }, [voiceId, voiceCheck]);
  const refreshVoice = useCallback(() => setVoiceCheck((n) => n + 1), []);

  // Clips by voice + text, finished or in progress. Refs, so the player's getClip (called from
  // audio callbacks) always sees the latest.
  const clips = useRef(new Map<string, AudioBuffer | Promise<AudioBuffer | undefined>>());
  const latest = useRef({ phraseAt, voiceId, voiceReady });
  useEffect(() => {
    latest.current = { phraseAt, voiceId, voiceReady };
  }, [phraseAt, voiceId, voiceReady]);

  const englishClip = useCallback((index: number): AudioBuffer | Promise<AudioBuffer | undefined> | undefined => {
    const { phraseAt: at, voiceId: voice, voiceReady: ready } = latest.current;
    const text = at(index)?.translation;
    if (!ready || !text) return undefined;
    const key = `${voice}\n${text}`;
    const have = clips.current.get(key);
    if (have) return have;
    const job = synthesize(voice, text).then(
      (buf) => {
        clips.current.set(key, buf);
        return buf;
      },
      () => {
        clips.current.delete(key); // try again next time
        return undefined;
      },
    );
    clips.current.set(key, job);
    while (clips.current.size > MAX_CLIPS) clips.current.delete(clips.current.keys().next().value!);
    return job;
  }, []);

  const prefetch = useCallback(
    (index: number) => {
      for (let i = index; i <= index + PREFETCH_AHEAD; i++) void englishClip(i);
    },
    [englishClip],
  );

  const getClip = useCallback(
    (index: number, clip: ClipKind) => (clip === "en" ? englishClip(index) : undefined),
    [englishClip],
  );

  return { enabled, phraseAt, progress, prefetch, getClip, voiceReady, refreshVoice };
}

export type Study = ReturnType<typeof useStudy>;
