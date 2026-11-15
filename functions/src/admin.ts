import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

if (getApps().length === 0) initializeApp();

export const db = getFirestore();
export const bucket = getStorage().bucket();

/** Functions are killed after 9 minutes at most, so a claim older than this belongs to a run that died. */
const STALE_CLAIM_MS = 10 * 60_000;

/**
 * Whether an episode still marked "transcribing" was claimed (its `updatedAt`) so long ago that the
 * run holding it must have been killed (timeout, out of memory), which leaves no chance to record
 * an error. Must match STALE_MS in web/src/pages/Practice.tsx.
 */
export function claimIsStale(updatedAt: unknown): boolean {
  const ms = (updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.();
  return ms !== undefined && Date.now() - ms > STALE_CLAIM_MS;
}
