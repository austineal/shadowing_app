import { collection, deleteField, doc, onSnapshot, query, setDoc, updateDoc, where, type Unsubscribe } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { updateEpisode } from "./episodes";
import type { CefrLevel, PhraseStudy } from "../types";

/** Must match normalizePhrase in functions/src/study.ts. */
export function normalizePhrase(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Id of a phrase's study doc: hash of language and normalised text. Must match the server. */
export async function phraseKey(language: string, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${language}\n${normalizePhrase(text)}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** Study material for every phrase of one episode, live. */
export function subscribeEpisodePhrases(
  uid: string,
  episodeId: string,
  cb: (phrases: Map<string, PhraseStudy>) => void,
  onError?: (e: Error) => void,
): Unsubscribe {
  const q = query(collection(db, "users", uid, "phrases"), where("episodeIds", "array-contains", episodeId));
  return onSnapshot(
    q,
    (snap) => cb(new Map(snap.docs.map((d) => [d.id, { key: d.id, ...(d.data() as Omit<PhraseStudy, "key">) }]))),
    onError,
  );
}

const levelsDoc = (uid: string) => doc(db, "users", uid, "prefs", "study");

/** The learner's CEFR level per language code. */
export function subscribeStudyLevels(uid: string, cb: (levels: Record<string, CefrLevel>) => void): Unsubscribe {
  return onSnapshot(levelsDoc(uid), (snap) => cb((snap.get("levels") ?? {}) as Record<string, CefrLevel>));
}

export async function setStudyLevel(uid: string, language: string, level: CefrLevel): Promise<void> {
  await setDoc(levelsDoc(uid), { levels: { [language]: level } }, { merge: true });
}

const prepareStudyFn = httpsCallable<
  { episodeId: string; language: string; english?: boolean; retry?: boolean },
  { total: number; missing: number; audio: number }
>(functions, "prepareStudy");

/**
 * Turns study mode on and queues anything missing (new phrases, a changed level, English audio
 * when requested). Cheap to call again: finished phrases are skipped. `retry` re-queues work
 * whose earlier tasks failed.
 */
export async function prepareStudy(episodeId: string, language: string, english?: boolean, retry = false) {
  return (await prepareStudyFn({ episodeId, language, retry, ...(english !== undefined ? { english } : {}) })).data;
}

export type ExplainMode = "detail" | "different" | "question";

const explainPhraseFn = httpsCallable<
  { key: string; episodeId: string; mode: ExplainMode; note?: number; question?: string },
  { answer: string }
>(functions, "explainPhrase", { timeout: 180_000 });

/**
 * Asks Claude a follow-up about a phrase: more detail on a note (or the whole phrase when `note`
 * is omitted), a different explanation, or a free question. The answer is also appended to the
 * phrase's thread, which the live subscription picks up.
 */
export async function explainPhrase(params: {
  key: string;
  episodeId: string;
  mode: ExplainMode;
  note?: number;
  question?: string;
}): Promise<string> {
  return (await explainPhraseFn(params)).data.answer;
}

export async function clearThread(uid: string, key: string): Promise<void> {
  await updateDoc(doc(db, "users", uid, "phrases", key), { thread: deleteField() });
}

/** Hides study material for the episode. Generated material is kept. */
export async function disableStudy(uid: string, episodeId: string): Promise<void> {
  await updateEpisode(uid, episodeId, { "study.enabled": false });
}
