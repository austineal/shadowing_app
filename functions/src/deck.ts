/**
 * Decks of audio flashcards. The client uploads each card's clips and a manifest; buildDeck joins
 * them into one constant-bitrate MP3 (each card, a pause, its English, a longer pause) and writes
 * the cards as the episode's segments, so the player, drills and offline copies treat a deck like
 * any other episode.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { db, bucket } from "./admin.js";
import { REGION } from "./config.js";
import { assertAllowed } from "./auth.js";
import { RATE, decode, encode } from "./deckAudio.js";


/** One card in the manifest the client uploads (deck.json); clip paths are relative to the episode's folder. */
interface ManifestCard {
  audio: string;
  text: string;
  english?: string;
  englishAudio?: string;
  lesson?: string;
}

/** Between a card and its English, and between one card and the next. */
const ENGLISH_GAP_SEC = 1.0;
const CARD_GAP_SEC = 1.5;
/** Clips decoded at once. */
const PARALLEL = 8;

/** Statuses from which a build may claim the deck. */
const CLAIMABLE = new Set(["uploaded", "error"]);

/** Runs `fn` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

function parseManifest(json: unknown): ManifestCard[] {
  if (!Array.isArray(json) || json.length === 0) throw new Error("The deck has no cards.");
  return json.map((c, i) => {
    const card = (c ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof card[k] === "string" && (card[k] as string).trim() ? (card[k] as string).trim() : undefined);
    const audio = str("audio");
    const text = str("text");
    if (!audio || !text) throw new Error(`Card ${i + 1} has no audio or no text.`);
    return { audio, text, english: str("english"), englishAudio: str("englishAudio"), lesson: str("lesson") };
  });
}

const silence = (sec: number) => Buffer.alloc(Math.round(sec * RATE) * 2);
const seconds = (bytes: number) => bytes / 2 / RATE;

async function build(uid: string, episodeId: string): Promise<void> {
  const ref = db.doc(`users/${uid}/episodes/${episodeId}`);
  const folder = `users/${uid}/episodes/${episodeId}`;
  const [manifestBytes] = await bucket.file(`${folder}/deck.json`).download();
  const cards = parseManifest(JSON.parse(manifestBytes.toString("utf8")));

  const dir = await mkdtemp(join(tmpdir(), "deck-"));
  try {
    const started = Date.now();
    const clip = async (path: string, name: string) => {
      const [bytes] = await bucket.file(`${folder}/${path}`).download();
      return decode(dir, name, bytes);
    };
    const decoded = await mapLimit(cards, PARALLEL, async (c, i) => ({
      audio: await clip(c.audio, `${i}`),
      english: c.englishAudio ? await clip(c.englishAudio, `${i}e`) : undefined,
    }));
    logger.info("Decoded deck clips", { cards: cards.length, ms: Date.now() - started });

    // Lay the cards end to end, noting where each card and its English fall.
    const parts: Buffer[] = [];
    let bytes = 0;
    const push = (b: Buffer) => {
      parts.push(b);
      bytes += b.length;
    };
    const segments = cards.map((c, i) => {
      const d = decoded[i];
      if (i > 0) push(silence(CARD_GAP_SEC));
      const start = seconds(bytes);
      push(d.audio);
      const end = seconds(bytes);
      const seg: Record<string, unknown> = { id: `c${i}`, start, end, text: c.text };
      if (d.english) {
        push(silence(ENGLISH_GAP_SEC));
        seg.enStart = seconds(bytes);
        push(d.english);
        seg.enEnd = seconds(bytes);
      }
      if (c.english) seg.english = c.english;
      if (c.lesson) seg.lesson = c.lesson;
      return seg;
    });
    push(silence(0.5));
    const mp3 = await encode(dir, Buffer.concat(parts, bytes));

    const audioPath = `${folder}/deck.mp3`;
    await bucket.file(audioPath).save(mp3, {
      contentType: "audio/mpeg",
      resumable: false,
      metadata: { metadata: { firebaseStorageDownloadTokens: randomUUID() } },
    });
    const longest = Math.max(...segments.map((s) => (s.end as number) - (s.start as number)));
    await db.doc(`${folder}/data/segments`).set({
      segments,
      source: "deck",
      tokensPath: "",
      maxPhraseSec: Math.ceil(longest),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await ref.update({
      status: "ready",
      audioPath,
      audioUrl: FieldValue.delete(),
      durationSec: seconds(bytes),
      cardCount: cards.length,
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.info("Built deck", { uid, episodeId, cards: cards.length, sec: Math.round(seconds(bytes)), mp3: mp3.length, ms: Date.now() - started });
    // The joined audio replaces the clips.
    await bucket.deleteFiles({ prefix: `${folder}/clips/` }).catch((e) => logger.warn("Removing clips failed", { err: String(e) }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Builds (or, after an error, rebuilds) a deck from its uploaded clips and manifest. */
export const buildDeck = onCall({ region: REGION, memory: "2GiB", cpu: 2, timeoutSeconds: 540 }, async (req) => {
  const uid = assertAllowed(req);
  const episodeId = (req.data as { episodeId?: unknown })?.episodeId;
  if (typeof episodeId !== "string" || !episodeId) throw new HttpsError("invalid-argument", "episodeId is required.");
  const ref = db.doc(`users/${uid}/episodes/${episodeId}`);

  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("kind") !== "deck" || !CLAIMABLE.has(snap.get("status"))) return false;
    tx.update(ref, { status: "transcribing", error: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
  if (!claimed) throw new HttpsError("failed-precondition", "This deck isn't waiting to be built.");

  try {
    await build(uid, episodeId);
    return { status: "ready", error: null };
  } catch (err) {
    const error = String(err instanceof Error ? err.message : err).slice(0, 1000);
    logger.error("Building deck failed", { uid, episodeId, err: error });
    await ref.update({ status: "error", error, updatedAt: FieldValue.serverTimestamp() });
    return { status: "error", error };
  }
});
