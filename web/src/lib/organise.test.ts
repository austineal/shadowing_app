import { describe, expect, it } from "vitest";
import { buildLibraryTree, episodeLanguage, feedStats, pubTime, type LibraryNode } from "./organise";
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
