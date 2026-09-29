/**
 * Firestore storage for drills: excerpts at users/{uid}/drills/{id}, per-language schedules in
 * users/{uid}/prefs/drill, and a log of sessions at users/{uid}/drillSessions/{id}.
 *
 * Writes made during a session aren't awaited: Firestore resolves them only once the server has
 * them, and sessions often run offline. They apply locally at once and sync later.
 */
import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  increment,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../firebase";
import { normalizePhrase, phraseKey } from "../study";
import type { Drill, DrillPassage, DrillPrefs, DrillSchedule, DrillSessionLog } from "../../types";

const drillsCollection = (uid: string) => collection(db, "users", uid, "drills");
const drillDoc = (uid: string, id: string) => doc(db, "users", uid, "drills", id);
const prefsDoc = (uid: string) => doc(db, "users", uid, "prefs", "drill");
const sessionsCollection = (uid: string) => collection(db, "users", uid, "drillSessions");

const toDrill = (d: QueryDocumentSnapshot<DocumentData>): Drill => ({ id: d.id, ...(d.data() as Omit<Drill, "id">) });

/** Firestore rejects undefined fields. */
function cleanPassage(p: DrillPassage): DrillPassage {
  const out: DrillPassage = { start: p.start, end: p.end };
  for (const k of ["level", "due", "last", "reviews", "lapses"] as const) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

export function subscribeDrills(uid: string, cb: (drills: Drill[]) => void, onError?: (e: Error) => void): Unsubscribe {
  return onSnapshot(drillsCollection(uid), (snap) => cb(snap.docs.map(toDrill)), onError);
}

export async function getDrills(uid: string, language: string): Promise<Drill[]> {
  const snap = await getDocs(query(drillsCollection(uid), where("language", "==", language)));
  return snap.docs.map(toDrill);
}

export async function createDrill(uid: string, drill: Omit<Drill, "id" | "createdAt">): Promise<string> {
  const ref = await addDoc(drillsCollection(uid), {
    ...drill,
    passages: drill.passages.map(cleanPassage),
    learning: drill.learning ?? null,
    createdAt: Date.now(),
  });
  return ref.id;
}

export async function deleteDrill(uid: string, id: string): Promise<void> {
  await deleteDoc(drillDoc(uid, id));
}

export function saveDrillProgress(uid: string, drill: Pick<Drill, "id" | "passages" | "learning">): void {
  void updateDoc(drillDoc(uid, drill.id), {
    passages: drill.passages.map(cleanPassage),
    learning: drill.learning ?? null,
  }).catch(() => undefined);
}

export function subscribeDrillPrefs(uid: string, cb: (prefs: DrillPrefs) => void, onError?: (e: Error) => void): Unsubscribe {
  return onSnapshot(prefsDoc(uid), (snap) => cb({ schedules: (snap.get("schedules") ?? {}) as Record<string, DrillSchedule> }), onError);
}

export async function getDrillPrefs(uid: string): Promise<DrillPrefs> {
  const snap = await getDoc(prefsDoc(uid));
  return { schedules: (snap.get("schedules") ?? {}) as Record<string, DrillSchedule> };
}

/** Sets a language's schedule (replacing it whole), or removes it with null. */
export async function setSchedule(uid: string, language: string, schedule: DrillSchedule | null): Promise<void> {
  if (!schedule) {
    await setDoc(prefsDoc(uid), { schedules: { [language]: deleteField() } }, { merge: true });
    return;
  }
  const clean: DrillSchedule = { ...schedule };
  if (clean.anchorDay === undefined) delete clean.anchorDay;
  await setDoc(prefsDoc(uid), { schedules: { [language]: clean } }, { mergeFields: [`schedules.${language}`] });
}

/** Sessions started since `since` (ms), live. */
export function subscribeRecentSessions(uid: string, since: number, cb: (logs: DrillSessionLog[]) => void): Unsubscribe {
  return onSnapshot(query(sessionsCollection(uid), where("startedAt", ">=", since)), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<DrillSessionLog, "id">) }))),
  );
}

/** Records the start of a session; returns its id for updateSessionLog. */
export function startSessionLog(uid: string, language: string, now: number): string {
  const ref = doc(sessionsCollection(uid));
  void setDoc(ref, { language, startedAt: now, endedAt: now, progress: 0, reviewed: 0, passed: 0, learnedPhrases: 0 }).catch(
    () => undefined,
  );
  return ref.id;
}

export function updateSessionLog(
  uid: string,
  id: string,
  endedAt: number,
  add: Partial<Pick<DrillSessionLog, "progress" | "reviewed" | "passed" | "learnedPhrases">> = {},
): void {
  const patch: Record<string, unknown> = { endedAt };
  for (const [k, v] of Object.entries(add)) if (v) patch[k] = increment(v);
  void updateDoc(doc(sessionsCollection(uid), id), patch).catch(() => undefined);
}

/**
 * English translations from the study material, by normalised phrase text. Phrases without one
 * (not generated yet, or not in the offline cache) are left out.
 */
export async function loadTranslations(uid: string, language: string, texts: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(texts.map(normalizePhrase))];
  const found = await Promise.all(
    unique.map(async (text) => {
      try {
        const snap = await getDoc(doc(db, "users", uid, "phrases", await phraseKey(language, text)));
        const translation = snap.get("translation");
        return typeof translation === "string" && translation.trim() ? ([text, translation.trim()] as const) : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return new Map(found.filter((x) => x !== undefined));
}

const prepareDrillStudyFn = httpsCallable<
  { episodeId: string; language: string; start: number; end: number; retry?: boolean },
  { total: number; missing: number }
>(functions, "prepareDrillStudy");

/**
 * Queues translations (and study notes) for the phrases of an excerpt only, without turning on
 * study mode for the whole episode. Needs the learner's level for the language to be set.
 */
export async function prepareDrillStudy(params: { episodeId: string; language: string; start: number; end: number; retry?: boolean }) {
  return (await prepareDrillStudyFn(params)).data;
}
