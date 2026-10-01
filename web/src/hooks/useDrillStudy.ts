import { useCallback, useEffect, useMemo, useState } from "react";
import { isKnownNote, visibleNotes } from "../lib/notes";
import { normalizePhrase, subscribeEpisodePhrases, subscribeKnownNotes } from "../lib/study";
import type { KnownNote, PhraseStudy } from "../types";

/**
 * Study material for the phrases a drill session plays, live: one subscription per episode in the
 * plan. Phrases are looked up by text, since a drill phrase carries no segment id.
 */
export function useDrillStudy(uid: string, language: string, episodeIds: string[]) {
  const ids = useMemo(() => [...new Set(episodeIds)].sort(), [episodeIds]);
  const idsKey = ids.join(",");

  const [byEpisode, setByEpisode] = useState<Record<string, Map<string, PhraseStudy>>>({});
  useEffect(() => {
    const unsubs = idsKey
      .split(",")
      .filter(Boolean)
      .map((id) =>
        subscribeEpisodePhrases(
          uid,
          id,
          (m) => setByEpisode((prev) => ({ ...prev, [id]: m })),
          () => undefined, // no study material is fine
        ),
      );
    return () => unsubs.forEach((u) => u());
  }, [uid, idsKey]);

  const [known, setKnown] = useState<KnownNote[]>([]);
  useEffect(() => subscribeKnownNotes(uid, language, setKnown), [uid, language]);

  const byText = useMemo(() => {
    const m = new Map<string, PhraseStudy>();
    for (const phrases of Object.values(byEpisode)) for (const p of phrases.values()) m.set(normalizePhrase(p.text), p);
    return m;
  }, [byEpisode]);

  const phraseFor = useCallback((text: string) => byText.get(normalizePhrase(text)), [byText]);

  /** A phrase's study material, if it has notes the learner hasn't marked as known. */
  const withNotes = useCallback(
    (text: string): PhraseStudy | undefined => {
      const p = phraseFor(text);
      return p && visibleNotes(p).some((n) => !isKnownNote(n, known)) ? p : undefined;
    },
    [phraseFor, known],
  );

  return { known, phraseFor, withNotes };
}
