import type { Timestamp } from "firebase/firestore";

export type EpisodeStatus = "uploading" | "uploaded" | "transcribing" | "ready" | "error";

export interface Episode {
  id: string;
  title: string;
  /** Language code chosen at import ("auto" for auto-detect). */
  language: string;
  status: EpisodeStatus;
  error?: string;
  source: "upload" | "rss";
  sourceUrl?: string | null;
  feedTitle?: string | null;
  audioPath: string;
  /** Cached Firebase download URL for the audio, saved after first lookup so offline playback needs no network. */
  audioUrl?: string;
  wordsPath?: string;
  /** Storage path of a user-supplied transcript (plain text). */
  transcriptPath?: string;
  durationSec?: number;
  wordCount?: number;
  detectedLanguage?: string;
  languageProbability?: number;
  createdAt: Timestamp | null;
  updatedAt?: Timestamp | null;
  /** Index of the segment the user was last on. */
  lastSegmentIndex?: number;
  settings?: Partial<PracticeSettings>;
}

export interface PracticeSettings {
  /** Upper bound on phrase length when auto-segmenting. */
  maxPhraseSec: number;
  /** Phrases shorter than this get merged with a neighbour. */
  minPhraseSec: number;
  /** Extra audio played before and after each phrase boundary. */
  paddingMs: number;
  /** Silence after each phrase as a multiple of the phrase duration (auto/loop modes). */
  gapFactor: number;
  /** Playback speed. */
  rate: number;
  /** manual: stop after each phrase. auto: pause for the gap then advance. loop: repeat current. */
  mode: "manual" | "auto" | "loop";
  /** How many times each phrase plays (with a gap after each) before auto mode advances. */
  repeats: number;
}

/** Quick-pick values offered for `repeats`. */
export const REPEAT_PRESETS = [1, 2, 3, 5, 10] as const;
export const MAX_REPEATS = 10;

export const DEFAULT_SETTINGS: PracticeSettings = {
  maxPhraseSec: 8,
  minPhraseSec: 1.2,
  paddingMs: 120,
  gapFactor: 1.3,
  rate: 1,
  mode: "manual",
  repeats: 1,
};

/** A word or spacing token with timestamps, as returned by speech-to-text or produced by alignment. */
export interface TimedToken {
  text: string;
  start: number;
  end: number;
  type: "word" | "spacing" | "audio_event";
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface SegmentsDoc {
  segments: Segment[];
  /** Where the text came from. */
  source: "asr" | "transcript";
  /** Storage path of the TimedToken[] the segments were built from (words.json or aligned.json). */
  tokensPath: string;
  /** Fraction of user-transcript tokens matched to recognised speech (transcript source only). */
  matchRatio?: number;
  maxPhraseSec: number;
  updatedAt?: Timestamp | null;
}

/** Shape of words.json written by the transcription function (ElevenLabs response). */
export interface WordsFile {
  language_code: string;
  language_probability: number;
  text: string;
  words: TimedToken[];
}
