import { describe, expect, it } from "vitest";
import { buildLibraryTree, episodeLanguage, feedStats, importedLookup, pubTime, searchEpisodes, type LibraryNode } from "./organise";
import type { Episode, Folder } from "../types";

function ep(id: string, extra: Partial<Episode> = {}): Episode {
  return { id, title: id, language: "fr", status: "ready", source: "upload", audioPath: "", createdAt: null, ...extra };
}

const radioX = { source: "rss" as const, feedUrl: "https://x/feed", feedTitle: "Radio X" };
const folders: Folder[] = [
  { id: "f1", name: "Grammar", language: "fr", createdAt: null },
  { id: "f2", name: "Empty", language: "cy", createdAt: null },
];
const episodes = [
  ep("a", { folderId: "f1" }),
  ep("b"),
  ep("c", { folderId: "gone" }),
  ep("d", radioX),
  ep("e", { ...radioX, folderId: "f1" }),
  ep("f", { source: "rss", feedTitle: "Old show", language: "cy" }),
  ep("g", { language: "auto", detectedLanguage: "jpn" }),
  ep("h", { language: "auto", status: "transcribing" }),
];

/** Compact view of the tree: label (count) [episode ids] { children }. */
function shape(nodes: LibraryNode[]): unknown {
  return nodes.map((n) => [`${n.label} (${n.count})`, n.episodes.map((e) => e.id), shape(n.children)]);
}

describe("buildLibraryTree", () => {
  it("nests folders and podcasts under languages and places each episode once", () => {
    expect(shape(buildLibraryTree(episodes, folders))).toEqual([
      ["French (5)", ["b", "c"], [
        ["Grammar (2)", ["a", "e"], []],
        ["Radio X (1)", ["d"], []],
      ]],
      ["Japanese (1)", ["g"], []],
      ["Welsh (1)", [], [
        ["Empty (0)", [], []],
        ["Old show (1)", ["f"], []],
      ]],
      ["Other (1)", ["h"], []],
    ]);
  });

  it("puts folders without a language under Other", () => {
    const tree = buildLibraryTree([], [{ id: "old", name: "Legacy", createdAt: null }]);
    expect(shape(tree)).toEqual([["Other (0)", [], [["Legacy (0)", [], []]]]]);
  });
});

describe("searchEpisodes", () => {
  const ids = (q: string, list = episodes) => searchEpisodes(list, folders, q).map((e) => e.id);
  const named = [
    ep("t", { title: "Passages - Le prisonnier de Téhéran" }),
    ep("l5", { title: "Lesson 05", language: "ja", folderId: "f3" }),
    ep("l15", { title: "Lesson 15", language: "ja", folderId: "f3" }),
    ep("p", { title: "#１５８７「レストラン」", language: "ja", ...radioX }),
  ];
  const withAssimil = [...folders, { id: "f3", name: "Assimil", language: "ja", createdAt: null }];

  it("finds titles regardless of case and accents", () => {
    expect(ids("TEHERAN", named)).toEqual(["t"]);
    expect(ids("téhéran", named)).toEqual(["t"]);
  });
  it("needs every word, from the title, podcast, folder or language", () => {
    expect(searchEpisodes(named, withAssimil, "assimil 05").map((e) => e.id)).toEqual(["l5"]);
    expect(searchEpisodes(named, withAssimil, "japanese lesson").map((e) => e.id)).toEqual(["l5", "l15"]);
    expect(ids("radio 1587", named)).toEqual(["p"]);
  });
  it("matches full-width characters typed as ordinary ones", () => {
    expect(ids("1587", named)).toEqual(["p"]);
  });
  it("finds nothing for an empty query", () => {
    expect(ids("  ", named)).toEqual([]);
  });
});

describe("episodeLanguage", () => {
  it("uses the chosen language, or the normalised detected one for auto", () => {
    expect(episodeLanguage({ language: "cy" })).toBe("cy");
    expect(episodeLanguage({ language: "auto", detectedLanguage: "fra" })).toBe("fr");
    expect(episodeLanguage({ language: "auto" })).toBe("unknown");
  });
});

describe("feedStats", () => {
  const feed = [
    { pubDate: "Tue, 01 Sep 2026 06:00:00 GMT" },
    { pubDate: "Wed, 16 Sep 2026 06:00:00 GMT" },
    { pubDate: "not a date" },
    {},
  ];
  it("finds the newest date and counts episodes after seenUpTo", () => {
    const seen = pubTime("Fri, 04 Sep 2026 00:00:00 GMT");
    expect(feedStats(feed, seen)).toEqual({ latestAt: pubTime("Wed, 16 Sep 2026 06:00:00 GMT"), newCount: 1 });
  });
  it("counts nothing as new once seen up to the latest", () => {
    const { latestAt } = feedStats(feed, 0);
    expect(feedStats(feed, latestAt).newCount).toBe(0);
  });
});

describe("importedLookup", () => {
  const feed = "https://x/feed";
  const library = [
    ep("guid", { ...radioX, title: "Épisode 1", guid: "g1", sourceUrl: "https://cdn/1.mp3?t=old" }),
    ep("url", { ...radioX, title: "Épisode 2", sourceUrl: "https://cdn/2.mp3?t=old" }),
    ep("title", { ...radioX, title: "Épisode 3", sourceUrl: "https://old-host/3.mp3" }),
    ep("elsewhere", { source: "rss", feedUrl: "https://y/feed", title: "Épisode 4", sourceUrl: "https://cdn/4.mp3" }),
  ];
  const find = importedLookup(library, feed);

  it("matches on guid even when the audio URL moved", () => {
    expect(find({ guid: "g1", title: "Renamed", audioUrl: "https://new/1.mp3" })?.id).toBe("guid");
  });
  it("matches the audio URL ignoring rotated query strings", () => {
    expect(find({ title: "Other", audioUrl: "https://cdn/2.mp3?t=new" })?.id).toBe("url");
  });
  it("matches on title within the same feed", () => {
    expect(find({ title: " Épisode 3 ", audioUrl: "https://new-host/3.mp3" })?.id).toBe("title");
  });
  it("matches the exact URL from another feed but not its title", () => {
    expect(find({ title: "x", audioUrl: "https://cdn/4.mp3" })?.id).toBe("elsewhere");
    expect(find({ title: "Épisode 4", audioUrl: "https://new/4.mp3" })).toBeUndefined();
  });
  it("leaves new episodes importable", () => {
    expect(find({ guid: "g9", title: "Épisode 9", audioUrl: "https://cdn/9.mp3" })).toBeUndefined();
  });
});
