import type { Episode, Folder } from "../types";
import { languageLabel, normalizeLanguageCode } from "./languages";

/** Groups episodes by the podcast they were imported from. */
export function showKey(ep: Pick<Episode, "feedUrl" | "feedTitle">): string | undefined {
  return ep.feedUrl || ep.feedTitle || undefined;
}

/** A feed URL without its query string or fragment, which tracking services rotate between fetches. */
function audioKey(url: string): string {
  return url.replace(/[?#].*$/, "");
}

/**
 * Finds the library copy of each feed episode, so it is offered as "Open" rather than imported again.
 * Matches on the feed's guid, then the audio URL (with or without its query), then, within the same
 * feed, the title — enclosure URLs change when a show switches host or tracking prefix.
 */
export function importedLookup<E extends Pick<Episode, "sourceUrl" | "feedUrl" | "guid" | "title">>(
  episodes: E[],
  feedUrl: string | undefined,
): (fe: { audioUrl: string; title: string; guid?: string }) => E | undefined {
  const byUrl = new Map<string, E>();
  const byGuid = new Map<string, E>();
  const byTitle = new Map<string, E>();
  for (const ep of episodes) {
    if (ep.sourceUrl) {
      byUrl.set(ep.sourceUrl, ep);
      if (!byUrl.has(audioKey(ep.sourceUrl))) byUrl.set(audioKey(ep.sourceUrl), ep);
    }
    if (feedUrl && ep.feedUrl === feedUrl) {
      if (ep.guid) byGuid.set(ep.guid, ep);
      byTitle.set(ep.title.trim(), ep);
    }
  }
  return (fe) =>
    (fe.guid ? byGuid.get(fe.guid) : undefined) ??
    byUrl.get(fe.audioUrl) ??
    byUrl.get(audioKey(fe.audioUrl)) ??
    byTitle.get(fe.title.trim());
}

/** The language an episode is filed under: the one chosen at import, or the detected one for auto-detect. */
export function episodeLanguage(ep: Pick<Episode, "language" | "detectedLanguage">): string {
  const code = ep.language === "auto" ? ep.detectedLanguage : ep.language;
  return normalizeLanguageCode(code) ?? "unknown";
}

/**
 * A branch of the library tree. Languages are the top level; inside each are the user's
 * folders, then one node per podcast, then episodes that belong to neither.
 */
export interface LibraryNode {
  id: string;
  kind: "language" | "folder" | "show";
  label: string;
  /** Language code this node sits under (the language itself for language nodes). */
  language: string;
  folder?: Folder;
  /** Feed of a podcast node, when known (older imports only recorded the title). */
  feedUrl?: string;
  children: LibraryNode[];
  episodes: Episode[];
  /** Episodes in this node and all its descendants. */
  count: number;
}

function node(kind: LibraryNode["kind"], id: string, label: string, language: string, folder?: Folder): LibraryNode {
  return { id, kind, label, language, folder, children: [], episodes: [], count: 0 };
}

const byLabel = (a: LibraryNode, b: LibraryNode) => a.label.localeCompare(b.label);

/**
 * Places every episode exactly once. A folder the user filed it in wins; otherwise it goes
 * under its language, inside its podcast's node if it came from a feed. Folders appear under
 * their own language even when empty. Episodes keep the order they were given in.
 */
export function buildLibraryTree(episodes: Episode[], folders: Folder[]): LibraryNode[] {
  const languages = new Map<string, LibraryNode>();
  const language = (code: string) => {
    let n = languages.get(code);
    if (!n) languages.set(code, (n = node("language", `lang:${code}`, code === "unknown" ? "Other" : languageLabel(code), code)));
    return n;
  };
  const folderNodes = new Map<string, LibraryNode>();
  for (const f of folders) {
    const code = normalizeLanguageCode(f.language ?? undefined) ?? "unknown";
    const n = node("folder", `folder:${f.id}`, f.name, code, f);
    folderNodes.set(f.id, n);
    language(code).children.push(n);
  }
  const shows = new Map<string, LibraryNode>();

  for (const ep of episodes) {
    const folder = ep.folderId ? folderNodes.get(ep.folderId) : undefined;
    if (folder) {
      folder.episodes.push(ep);
      continue;
    }
    const code = episodeLanguage(ep);
    const key = showKey(ep);
    if (!key) {
      language(code).episodes.push(ep);
      continue;
    }
    const id = `show:${code}:${key}`;
    let show = shows.get(id);
    if (!show) {
      shows.set(id, (show = node("show", id, ep.feedTitle || key, code)));
      show.feedUrl = ep.feedUrl ?? undefined;
      language(code).children.push(show);
    }
    show.episodes.push(ep);
  }

  const finish = (n: LibraryNode): number => {
    // Folders first, then podcasts, each alphabetical.
    n.children.sort((a, b) => (a.kind === b.kind ? byLabel(a, b) : a.kind === "folder" ? -1 : 1));
    n.count = n.episodes.length + n.children.reduce((sum, c) => sum + finish(c), 0);
    return n.count;
  };
  const roots = [...languages.values()];
  roots.forEach(finish);
  // "Other" last: episodes whose language isn't detected yet, and folders made before folders had a language.
  return roots.sort((a, b) => (a.language === "unknown" ? 1 : b.language === "unknown" ? -1 : byLabel(a, b)));
}

/** Lower case, without accents or width variants, so "teheran" finds "Téhéran". */
export function searchKey(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * The episodes a search finds: those with every word of the query in their title, podcast, folder
 * or language. They keep the order they were given in.
 */
export function searchEpisodes(episodes: Episode[], folders: Folder[], query: string): Episode[] {
  const words = searchKey(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  return episodes.filter((ep) => {
    const lang = episodeLanguage(ep);
    const fields = [ep.title, ep.feedTitle, ep.folderId && folderName.get(ep.folderId), lang !== "unknown" && languageLabel(lang)];
    const text = searchKey(fields.filter(Boolean).join("\n"));
    return words.every((w) => text.includes(w));
  });
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
