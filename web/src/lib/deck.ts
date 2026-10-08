/**
 * Decks of audio flashcards: reading a CSV of cards against the audio files chosen with it,
 * uploading them for the buildDeck function (which joins them into one episode), and drilling a
 * deck card by card.
 */
import { doc, runTransaction, serverTimestamp, setDoc } from "firebase/firestore";
import { ref, uploadBytes, uploadString } from "firebase/storage";
import { httpsCallable } from "firebase/functions";
import { db, functions, storage } from "../firebase";
import { episodesCollection } from "./episodes";
import { createDrill } from "./drill/store";
import type { DrillPassage, Episode, Segment } from "../types";

// ---- CSV ----

/** Parses CSV (or TSV, or semicolon-separated) text, with quoted fields. Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const count = (c: string) => firstLine.split(c).length - 1;
  const sep = ["\t", ",", ";"].sort((a, b) => count(b) - count(a))[0];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  rows.push(row);
  return rows.map((r) => r.map((f) => f.trim())).filter((r) => r.some((f) => f !== ""));
}

/** The file a cell names: a bare file name or path, or Anki's [sound:name.mp3]. */
export function fileRef(cell: string): string {
  const anki = /\[sound:([^\]]+)\]/.exec(cell);
  const name = (anki ? anki[1] : cell).trim();
  return name.split(/[\\/]/).pop()!.toLowerCase();
}

// ---- Columns ----

export type Role = "audio" | "englishAudio" | "text" | "english";
export type Columns = Record<Role, number | null>;

export const ROLE_LABEL: Record<Role, string> = {
  audio: "Card audio",
  englishAudio: "English audio",
  text: "Sentence",
  english: "English text",
};

const LATIN = /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}]*$/u;

/**
 * Guesses which column is which: audio columns are the ones naming the chosen files (the first is
 * the card's, the English one has "en" in its header or comes second); the sentence is the text
 * not in Latin script (or headed so), the English the Latin one. Other columns are ignored.
 */
export function guessColumns(header: string[] | null, rows: string[][], files: Set<string>): Columns {
  const width = Math.max(header?.length ?? 0, ...rows.map((r) => r.length));
  const cols = Array.from({ length: width }, (_, i) => i);
  const sample = rows.slice(0, 50);
  const name = (i: number) => (header?.[i] ?? "").toLowerCase();
  const share = (i: number, test: (v: string) => boolean) => {
    const vals = sample.map((r) => r[i] ?? "").filter(Boolean);
    return vals.length ? vals.filter(test).length / vals.length : 0;
  };
  const isEnglishHeader = (i: number) => /\b(en|eng|english|meaning|translation|gloss)\b/.test(name(i).replace(/[_-]/g, " "));

  const audio = cols.filter((i) => share(i, (v) => files.has(fileRef(v))) >= 0.6);
  const englishAudio = audio.find(isEnglishHeader) ?? (audio.length > 1 ? audio[1] : undefined);
  const cardAudio = audio.find((i) => i !== englishAudio);

  const textCols = cols.filter((i) => !audio.includes(i) && share(i, (v) => v.length > 0) > 0.5);
  const rest = textCols;
  const english = rest.find(isEnglishHeader) ?? rest.find((i) => share(i, (v) => LATIN.test(v) && /[a-z]/i.test(v)) > 0.8);
  const text =
    rest.find((i) => i !== english && /sentence|text|expression|japanese|target|front|jp|ja/.test(name(i))) ??
    rest.find((i) => i !== english && share(i, (v) => !LATIN.test(v)) > 0.5) ??
    rest.find((i) => i !== english);

  return {
    audio: cardAudio ?? null,
    englishAudio: englishAudio ?? null,
    text: text ?? null,
    english: english ?? null,
  };
}

/** Whether the first row is a header: none of its cells name a chosen file, or look like an audio file. */
export function hasHeader(rows: string[][], files: Set<string>): boolean {
  const isAudio = (c: string) => files.has(fileRef(c)) || /\[sound:|\.(mp3|m4a|ogg|opus|wav|flac|aac)$/i.test(c.trim());
  return rows.length > 0 && !rows[0].some(isAudio);
}

// ---- Cards ----

interface DeckCard {
  audio: File;
  text: string;
  english?: string;
  englishAudio?: File;
}

interface DeckRead {
  cards: DeckCard[];
  /** Rows left out, with why. */
  skipped: { row: number; why: string }[];
}

/** The cards the rows describe with the columns given, matched to the chosen files by name. */
export function readCards(rows: string[][], cols: Columns, files: File[], firstRow: number): DeckRead {
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const cell = (r: string[], c: number | null) => (c === null ? "" : (r[c] ?? "").trim());
  const cards: DeckCard[] = [];
  const skipped: DeckRead["skipped"] = [];
  rows.forEach((r, k) => {
    const row = firstRow + k + 1;
    const audioName = cell(r, cols.audio);
    const audio = audioName ? byName.get(fileRef(audioName)) : undefined;
    const text = cell(r, cols.text);
    if (!audio) return skipped.push({ row, why: audioName ? `no file called ${fileRef(audioName)}` : "no audio" });
    if (!text) return skipped.push({ row, why: "no sentence" });
    const enName = cell(r, cols.englishAudio);
    const englishAudio = enName ? byName.get(fileRef(enName)) : undefined;
    if (enName && !englishAudio) return skipped.push({ row, why: `no file called ${fileRef(enName)}` });
    const english = cell(r, cols.english);
    cards.push({ audio, text, ...(english ? { english } : {}), ...(englishAudio ? { englishAudio } : {}) });
  });
  return { cards, skipped };
}

// ---- Upload ----

const extension = (f: File) => /\.([A-Za-z0-9]{2,5})$/.exec(f.name)?.[1].toLowerCase() ?? "mp3";

const buildDeckFn = httpsCallable<{ episodeId: string }, { status: string; error: string | null }>(functions, "buildDeck", {
  timeout: 540_000,
});

/** Joins a deck's uploaded clips into its audio. Also retries a build that failed. */
export async function buildDeck(episodeId: string) {
  return (await buildDeckFn({ episodeId })).data;
}

/**
 * Creates the deck's episode, uploads its clips and the manifest buildDeck reads, then starts the
 * build (without waiting for it). Returns the episode id.
 */
export async function uploadDeck(
  uid: string,
  params: { title: string; language: string; folderId: string | null; cards: DeckCard[]; onProgress?: (fraction: number) => void },
): Promise<string> {
  const episodeRef = doc(episodesCollection(uid));
  const folder = `users/${uid}/episodes/${episodeRef.id}`;
  await setDoc(episodeRef, {
    title: params.title.trim() || "Deck",
    language: params.language,
    status: "uploading",
    source: "upload",
    kind: "deck",
    cardCount: params.cards.length,
    folderId: params.folderId,
    audioPath: `${folder}/deck.mp3`,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const uploads: { file: File; path: string }[] = [];
  const manifest = params.cards.map((c, i) => {
    const audio = `clips/${i}.${extension(c.audio)}`;
    uploads.push({ file: c.audio, path: audio });
    const entry: Record<string, string> = { audio, text: c.text };
    if (c.englishAudio) {
      entry.englishAudio = `clips/${i}e.${extension(c.englishAudio)}`;
      uploads.push({ file: c.englishAudio, path: entry.englishAudio });
    }
    if (c.english) entry.english = c.english;
    return entry;
  });

  let done = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < uploads.length) {
        const u = uploads[next++];
        await uploadBytes(ref(storage, `${folder}/${u.path}`), u.file, { contentType: u.file.type || "audio/mpeg" });
        params.onProgress?.(++done / uploads.length);
      }
    }),
  );
  await uploadString(ref(storage, `${folder}/deck.json`), JSON.stringify(manifest), "raw", { contentType: "application/json" });

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(episodeRef);
    if (snap.exists() && snap.get("status") === "uploading") tx.update(episodeRef, { status: "uploaded", updatedAt: serverTimestamp() });
  });
  void buildDeck(episodeRef.id).catch((e) => console.warn("Building the deck failed:", e));
  return episodeRef.id;
}

// ---- Drilling ----

/** A deck's cards as drill passages, shuffled: the order they'll be learned in. */
export function cardPassages(segments: Segment[], random: () => number = Math.random): DrillPassage[] {
  const cards = [...segments];
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards.map((s) => ({ start: s.start, end: s.end, card: true }));
}

/** Starts drilling a deck: every card, learned in the shuffled order cardPassages gives. */
export async function createCardsDrill(uid: string, episode: Episode, language: string, segments: Segment[], schedule: string) {
  return createDrill(uid, {
    kind: "cards",
    schedule,
    episodeId: episode.id,
    episodeTitle: episode.title,
    title: episode.title,
    language,
    start: 0,
    end: episode.durationSec ?? Math.max(...segments.map((s) => s.enEnd ?? s.end)),
    passages: cardPassages(segments),
    learning: null,
  });
}
