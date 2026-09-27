import type { Episode, Folder } from "../types";

/** Library filter: everything, unfiled episodes, one folder, or one podcast show. */
export type LibraryFilter = "all" | "unfiled" | `folder:${string}` | `show:${string}`;

export interface Show {
  key: string;
  title: string;
  count: number;
}

/** Groups episodes by the podcast they were imported from. */
export function showKey(ep: Pick<Episode, "feedUrl" | "feedTitle">): string | undefined {
  return ep.feedUrl || ep.feedTitle || undefined;
}

export function listShows(episodes: Episode[]): Show[] {
  const byKey = new Map<string, Show>();
  for (const ep of episodes) {
    const key = showKey(ep);
    if (!key) continue;
    const show = byKey.get(key);
    if (show) show.count++;
    else byKey.set(key, { key, title: ep.feedTitle || key, count: 1 });
  }
  return [...byKey.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** Episodes whose folder no longer exists are treated as unfiled. */
export function isUnfiled(ep: Episode, folderIds: Set<string>): boolean {
  return !ep.folderId || !folderIds.has(ep.folderId);
}

export function filterEpisodes(episodes: Episode[], folders: Folder[], filter: LibraryFilter): Episode[] {
  if (filter === "all") return episodes;
  if (filter === "unfiled") {
    const ids = new Set(folders.map((f) => f.id));
    return episodes.filter((ep) => isUnfiled(ep, ids));
  }
  if (filter.startsWith("folder:")) {
    const id = filter.slice("folder:".length);
    return episodes.filter((ep) => ep.folderId === id);
  }
  const key = filter.slice("show:".length);
  return episodes.filter((ep) => showKey(ep) === key);
}

export function parseFilter(raw: string | null): LibraryFilter {
  if (raw === "unfiled") return raw;
  if (raw && /^(folder|show):./.test(raw)) return raw as LibraryFilter;
  return "all";
}

/** Publish time in ms, or 0 when the feed omits or garbles the date. */
export function pubTime(pubDate: string | undefined): number {
  if (!pubDate) return 0;
  const t = Date.parse(pubDate);
  return Number.isFinite(t) ? t : 0;
}

/** Newest publish time in a feed and how many episodes are newer than `seenUpTo`. */
export function feedStats(episodes: { pubDate?: string }[], seenUpTo: number): { latestAt: number; newCount: number } {
  let latestAt = 0;
  let newCount = 0;
  for (const ep of episodes) {
    const t = pubTime(ep.pubDate);
    if (t > latestAt) latestAt = t;
    if (t > seenUpTo) newCount++;
  }
  return { latestAt, newCount };
}
