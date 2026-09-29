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
  /** RSS feed the episode was imported from; groups episodes by show in the library. */
  feedUrl?: string | null;
  /** User folder the episode is filed in (null/absent = unfiled). */
  folderId?: string | null;
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
  study?: EpisodeStudy;
}

export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

/** Study-mode state on the episode document. Written by the prepareStudy function. */
export interface EpisodeStudy {
  enabled: boolean;
  language: string;
  /** The learner level the notes were generated for. */
  level: CefrLevel;
  error?: string | null;
}

export interface StudyNote {
  kind: "grammar" | "idiom" | "vocab" | "culture" | "pronunciation" | "transcription";
  /** Exact substring of the phrase the note is about. */
  span: string;
  title: string;
  body: string;
  level: CefrLevel;
}

/**
 * Study material for one phrase text, at users/{uid}/phrases/{key} (see phraseKey). Shared by
 * every episode (and segment) with the same text in the same language.
 */
export interface PhraseStudy {
  key: string;
  lang: string;
  text: string;
  level: CefrLevel;
  translation: string;
  literal: string;
  notes: StudyNote[];
  episodeIds: string[];
  /** Follow-up questions and Claude's answers, oldest first. */
  thread?: ThreadEntry[];
}

export interface ThreadEntry {
  role: "user" | "assistant";
  /** For user entries, a short label of what was asked. */
  text: string;
  at: number;
}

export interface Folder {
  id: string;
  name: string;
  /** Language the folder sits under in the library tree. */
  language?: string | null;
  createdAt: Timestamp | null;
}

/** A podcast the user follows. Stored at users/{uid}/subscriptions/{id}, where id is derived from feedUrl. */
export interface Subscription {
  id: string;
  feedUrl: string;
  title: string;
  image?: string | null;
  /** Language used when importing episodes from this show. */
  language: string;
  createdAt: Timestamp | null;
  /** When the feed was last fetched to look for new episodes. */
  lastCheckedAt?: Timestamp | null;
  /** Publish time (ms) of the newest episode seen in the feed. */
  latestAt: number;
  /** Episodes published after this time (ms) count as new. Advanced when the user opens the show. */
  seenUpTo: number;
  /** Number of episodes published after seenUpTo, as of the last check. */
  newCount: number;
  checkError?: string | null;
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
  /** In auto and loop modes, the first this-many plays of each phrase use slowRate (0 = off). */
  slowPlays: number;
  /** Speed for the slowed plays; never faster than `rate`. */
  slowRate: number;
  /** manual: stop after each phrase. auto: pause for the gap then advance. loop: repeat current. */
  mode: "manual" | "auto" | "loop";
  /** How many times each phrase plays (with a gap after each) before auto mode advances. */
  repeats: number;
  /** When the English translation audio plays, between the phrase and the pause (study mode). */
  english: "off" | "first" | "each";
  /** Piper voice (on-device TTS) that reads the English. */
  englishVoice: string;
  /** Show the translation under the current phrase (study mode). */
  showTranslation: boolean;
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
  slowPlays: 2,
  slowRate: 0.75,
  english: "off",
  englishVoice: "en_GB-alba-medium",
  showTranslation: false,
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
