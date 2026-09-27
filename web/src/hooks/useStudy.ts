import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { phraseKey, subscribeEpisodePhrases } from "../lib/study";
import type { ClipKind } from "../lib/sequence";
import type { Episode, PhraseStudy, Segment } from "../types";

/** How many phrases ahead of the current one to download English audio for. */
const PREFETCH_AHEAD = 3;

function englishUrl(p: PhraseStudy | undefined): string | undefined {
  return p?.enAudioUrl && p.enAudioText === p.translation ? p.enAudioUrl : undefined;
}

async function decodeClip(url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Clip download failed (${res.status}).`);
  const data = await res.arrayBuffer();
  // AudioBuffers aren't tied to the context that decoded them, so the player's graph can play these.
  return new OfflineAudioContext(1, 1, 44100).decodeAudioData(data);
}

/**
 * Study material for the episode's phrases, plus decoded English clips for the player.
 * `language` must be a concrete code (not "auto").
 */
export function useStudy(uid: string, episode: Episode, segments: Segment[], language: string) {
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
    let voiced = 0;
    let chars = 0;
    for (const k of unique) {
      const p = phrases.get(k);
      if (!p || p.level !== level) continue;
      done++;
      chars += p.translation.length;
      if (englishUrl(p)) voiced++;
    }
    return { total: unique.size, done, voiced, chars };
  }, [keys, phrases, episode.study?.level]);

  // Decoded clips by URL. Refs, so the player's getClip (called from audio callbacks) sees the latest.
  const clips = useRef(new Map<string, AudioBuffer>());
  const loading = useRef(new Set<string>());
  const phraseAtRef = useRef(phraseAt);
  useEffect(() => {
    phraseAtRef.current = phraseAt;
  }, [phraseAt]);

  const prefetch = useCallback((index: number) => {
    for (let i = index; i <= index + PREFETCH_AHEAD; i++) {
      const url = englishUrl(phraseAtRef.current(i));
      if (!url || clips.current.has(url) || loading.current.has(url)) continue;
      loading.current.add(url);
      decodeClip(url)
        .then((buf) => clips.current.set(url, buf))
        .catch(() => undefined) // missing clip is skipped at play time
        .finally(() => loading.current.delete(url));
    }
  }, []);

  const getClip = useCallback((index: number, clip: ClipKind): AudioBuffer | undefined => {
    if (clip !== "en") return undefined;
    const url = englishUrl(phraseAtRef.current(index));
    return url ? clips.current.get(url) : undefined;
  }, []);

  return { enabled, phraseAt, progress, prefetch, getClip };
}

export type Study = ReturnType<typeof useStudy>;
