import type { Timestamp } from "firebase/firestore";

type EpisodeStatus = "uploading" | "uploaded" | "transcribing" | "ready" | "error";

export interface Episode {
  id: string;
  title: string;
  /** Language code chosen at import ("auto" for auto-detect). */
  language: string;
  status: EpisodeStatus;
  error?: string;
  source: "upload" | "rss";
  /** "deck": a deck of audio flashcards joined into one audio file, a card per segment (see buildDeck). */
  kind?: "deck";
  cardCount?: number;
  sourceUrl?: string | null;
  /** The feed item's <guid>, for recognising the episode after its audio URL changes. */
  guid?: string | null;
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
interface EpisodeStudy {
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
 * A study point the learner has said they already know, at users/{uid}/knownNotes/{id}. Notes on
 * the same point are hidden, and Claude is told to leave it out of new material.
 */
export interface KnownNote {
  id: string;
  lang: string;
  kind: StudyNote["kind"];
  span: string;
  title: string;
  /** Milliseconds since the epoch. */
  at: number;
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
  english: "off",
  englishVoice: "en_GB-alba-medium",
  showTranslation: false,
};

/**
 * An excerpt of an episode being drilled, at users/{uid}/drills/{id}. The learner works through
 * its passages in order and reviews each on a spaced schedule.
 */
export interface Drill {
  id: string;
  episodeId: string;
  /** Episode title when the excerpt was chosen, for lists that don't load the episode. */
  episodeTitle: string;
  /** Short title from Claude: the suggested section's, or given when its passages were planned. */
  title?: string;
  /** Concrete language code (never "auto"). */
  language: string;
  /** Key of the schedule it's drilled on (see DrillPrefs.schedules). Absent: the language's main one. */
  schedule?: string;
  /** Excerpt bounds, in seconds of episode audio. */
  start: number;
  end: number;
  /** The excerpt cut into passages, in order. Each ends where the next begins. */
  passages: DrillPassage[];
  /** The passage being learned and how many of its phrases are done, so learning can resume next session. */
  learning?: { passage: number; phrases: number } | null;
  /**
   * "cards": a deck drilled card by card, each card a passage of one phrase. The passages are in
   * the order they're learned (shuffled when the drill is made), reviewed in shuffled rounds.
   */
  kind?: "cards";
  /** When the excerpt was chosen (ms since epoch). */
  createdAt: number;
}

/**
 * One passage of a drill excerpt. Passages are time ranges rather than phrase ids, so splitting,
 * merging or rebuilding phrases never orphans them: a phrase belongs to the passage containing
 * its midpoint.
 */
export interface DrillPassage {
  start: number;
  end: number;
  /** Short title from Claude, when the passages were planned by it. */
  title?: string;
  /** Absent until learned. 0 = learned, due at the next session; each passed review moves it up. */
  level?: number;
  /** When the next review is due (ms since epoch). */
  due?: number;
  /** When it was last learned or reviewed (ms since epoch). */
  last?: number;
  reviews?: number;
  lapses?: number;
  /** A card of a deck rather than a stretch of an episode (see Drill.kind). */
  card?: boolean;
}

/**
 * How often a set of drills comes up. Stored in users/{uid}/prefs/drill. A language's main
 * schedule is keyed by its code; it can have more, each with a generated key and its own drills.
 */
export interface DrillSchedule {
  /** The language, for schedules other than the main one (whose key is the language). */
  language?: string;
  /** What it's for ("News podcast", "Kanji deck"), to tell a language's schedules apart. */
  name?: string;
  /** Sessions a day, for languages drilled every day. */
  perDay: number;
  /** Days between sessions; 1 = every day. */
  everyDays: number;
  /** Planned length of a session. */
  minutes: number;
  /** Whether sessions start new passages once the due reviews are done. */
  newMaterial: boolean;
  /** full: three listen-and-repeat plays, the first two slowed. light: two plays at normal speed. */
  learning: "full" | "light";
  /** Extra seconds to answer after each English cue (absent: none). */
  answerTime?: number;
  /** For languages drilled every few days: a day number (see dayNumber) the cycle counts from, so they can take turns. */
  anchorDay?: number;
}

export interface DrillPrefs {
  /** By key: a language code for its main schedule, else a generated key (see DrillSchedule). */
  schedules: Record<string, DrillSchedule>;
  /** Piper voice that reads drills' English cues. Absent: the practice player's default voice. */
  voice?: string;
}

/** One drill session, at users/{uid}/drillSessions/{id}. */
export interface DrillSessionLog {
  id: string;
  language: string;
  /** The schedule it was a session of. Absent: the language's main one. */
  schedule?: string;
  startedAt: number;
  endedAt: number;
  /** Passages reviewed or learned and phrases learned. A session with none doesn't count towards the schedule. */
  progress: number;
  reviewed: number;
  passed: number;
  learnedPhrases: number;
  /** Audio in the passages fully learned, in seconds. Absent from logs made before it was recorded. */
  learnedSeconds?: number;
}

/** A section of an episode suggested as a drill excerpt. */
export interface ExcerptSection {
  start: number;
  end: number;
  title: string;
  summary: string;
  /** good: natural speech worth being able to say. fair: usable but less so. skip: not worth drilling. */
  speaking: "good" | "fair" | "skip";
  why: string;
  /** CEFR level needed to follow it comfortably. */
  level: CefrLevel;
}

/** Claude's excerpt suggestions for an episode, at users/{uid}/episodes/{id}/data/excerpts. */
export interface ExcerptSuggestions {
  language: string;
  /** The learner's level and the section length the suggestions were made for. */
  level: CefrLevel;
  minutes: number;
  sections: ExcerptSection[];
  createdAt: Timestamp | null;
}

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
  /** Deck cards: the English from the deck, and where its English audio lies. */
  english?: string;
  enStart?: number;
  enEnd?: number;
}

export interface SegmentsDoc {
  segments: Segment[];
  /** Where the text came from. */
  source: "asr" | "transcript" | "deck";
  /** Storage path of the TimedToken[] the segments were built from (words.json or aligned.json); empty for a deck. */
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
