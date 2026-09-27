import { describe, expect, it } from "vitest";
import { feedStats, filterEpisodes, listShows, parseFilter, pubTime } from "./organise";
import type { Episode, Folder } from "../types";

function ep(id: string, extra: Partial<Episode> = {}): Episode {
  return { id, title: id, language: "fr", status: "ready", source: "upload", audioPath: "", createdAt: null, ...extra };
}

const folders: Folder[] = [{ id: "f1", name: "Welsh", createdAt: null }];
const episodes = [
  ep("a", { folderId: "f1" }),
  ep("b"),
  ep("c", { folderId: "gone" }),
  ep("d", { source: "rss", feedUrl: "https://x/feed", feedTitle: "Radio X" }),
  ep("e", { source: "rss", feedUrl: "https://x/feed", feedTitle: "Radio X", folderId: "f1" }),
  ep("f", { source: "rss", feedTitle: "Old show" }),
];
const ids = (list: Episode[]) => list.map((e) => e.id);

describe("filterEpisodes", () => {
  it("returns everything for all", () => {
    expect(ids(filterEpisodes(episodes, folders, "all"))).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
  it("treats missing and deleted folders as unfiled", () => {
    expect(ids(filterEpisodes(episodes, folders, "unfiled"))).toEqual(["b", "c", "d", "f"]);
  });
  it("filters by folder", () => {
    expect(ids(filterEpisodes(episodes, folders, "folder:f1"))).toEqual(["a", "e"]);
  });
  it("filters by show, falling back to feed title for older imports", () => {
    expect(ids(filterEpisodes(episodes, folders, "show:https://x/feed"))).toEqual(["d", "e"]);
    expect(ids(filterEpisodes(episodes, folders, "show:Old show"))).toEqual(["f"]);
  });
});

describe("listShows", () => {
  it("groups by feed and sorts by title", () => {
    expect(listShows(episodes)).toEqual([
      { key: "Old show", title: "Old show", count: 1 },
      { key: "https://x/feed", title: "Radio X", count: 2 },
    ]);
  });
});

describe("parseFilter", () => {
  it("accepts known shapes and defaults to all", () => {
    expect(parseFilter("unfiled")).toBe("unfiled");
    expect(parseFilter("folder:abc")).toBe("folder:abc");
    expect(parseFilter("show:https://x/feed")).toBe("show:https://x/feed");
    expect(parseFilter("folder:")).toBe("all");
    expect(parseFilter("nonsense")).toBe("all");
    expect(parseFilter(null)).toBe("all");
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
