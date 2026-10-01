/**
 * Makes the English for upcoming drill sessions ahead of time, so they can start at once. Plans
 * each schedule's next session as it would run now and synthesises whatever English isn't stored
 * on the device yet. It only runs when the voice is already downloaded, a clip at a time, and
 * stops as soon as it's cancelled (its page going away), so it never holds up English that's
 * needed right now: the speech worker handles one request at a time.
 */
import { isVoiceStored } from "../tts/client";
import { ensureClip, pruneClips } from "../tts/clipCache";
import { prepareSession } from "./prepare";

/** A run this soon after the last complete one is skipped. */
const MIN_GAP_MS = 2 * 60_000;
let lastComplete = 0;
/** Runs are chained, so a new one starts only once a cancelled one has let go of the worker. */
let current: Promise<unknown> = Promise.resolve();

async function run(uid: string, keys: string[], voiceId: string, cancelled: () => boolean): Promise<number> {
  if (cancelled() || Date.now() - lastComplete < MIN_GAP_MS) return 0;
  if (!(await isVoiceStored(voiceId))) return 0;
  let made = 0;
  let failed = false;
  for (const key of keys) {
    if (cancelled()) return made;
    const prepared = await prepareSession(uid, key, Date.now(), { withAudio: false }).catch(() => undefined);
    if (!prepared) failed = true;
    for (const text of prepared?.english ?? []) {
      if (cancelled()) return made;
      try {
        if (await ensureClip(voiceId, text)) made++;
      } catch {
        failed = true; // e.g. the speech worker restarted: try again on the next visit
      }
    }
  }
  if (!failed) lastComplete = Date.now();
  await pruneClips().catch(() => 0);
  return made;
}

/**
 * Prepares the English for the next sessions of the given schedules (by key), in order. Returns how many clips it
 * had to make. `force` skips the check for a recent run (after a session, say).
 */
export function prefetchDrillEnglish(
  uid: string,
  keys: string[],
  voiceId: string,
  cancelled: () => boolean,
  force = false,
): Promise<number> {
  const next = current.then(() => {
    if (force) lastComplete = 0;
    return run(uid, keys, voiceId, cancelled);
  });
  current = next.catch(() => 0);
  return next;
}
