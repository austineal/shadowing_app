import { DEFAULT_SETTINGS, type PracticeSettings } from "../types";

const KEY = "shadowing.defaultSettings";

/** A saved copy of settings without fields that have since been removed, so saving it again drops them. */
function currentFields(saved: Partial<PracticeSettings> | undefined): Partial<PracticeSettings> {
  return Object.fromEntries(Object.entries(saved ?? {}).filter(([k]) => k in DEFAULT_SETTINGS));
}

/** Global defaults, used for new episodes. Per-episode overrides live on the episode document. */
export function loadDefaultSettings(): PracticeSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...currentFields(JSON.parse(raw) as Partial<PracticeSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** An episode's settings: its own saved ones over the global defaults. */
export function episodeSettings(saved: Partial<PracticeSettings> | undefined): PracticeSettings {
  return { ...loadDefaultSettings(), ...currentFields(saved) };
}

export function saveDefaultSettings(s: PracticeSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

const FEEDS_KEY = "shadowing.recentFeeds";

export interface RecentFeed {
  url: string;
  title: string;
}

export function loadRecentFeeds(): RecentFeed[] {
  try {
    return JSON.parse(localStorage.getItem(FEEDS_KEY) ?? "[]") as RecentFeed[];
  } catch {
    return [];
  }
}

export function rememberFeed(feed: RecentFeed): void {
  const list = [feed, ...loadRecentFeeds().filter((f) => f.url !== feed.url)].slice(0, 10);
  try {
    localStorage.setItem(FEEDS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}
