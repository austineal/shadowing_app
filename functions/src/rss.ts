import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { XMLParser } from "fast-xml-parser";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db, bucket } from "./admin.js";
import { REGION } from "./config.js";
import { assertAllowed } from "./auth.js";

const USER_AGENT = "shadowing-app/0.1 (+https://github.com/austin/shadowing_app)";

interface FeedEpisode {
  title: string;
  audioUrl: string;
  mimeType?: string;
  pubDate?: string;
  durationSec?: number;
  description?: string;
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)["#text"]);
  }
  return undefined;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function parseDuration(v: unknown): number | undefined {
  const s = text(v);
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function assertHttpUrl(raw: unknown, field: string): URL {
  if (typeof raw !== "string") throw new HttpsError("invalid-argument", `${field} is required.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpsError("invalid-argument", `${field} is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpsError("invalid-argument", `${field} must be http(s).`);
  }
  return url;
}

/** Fetches and parses a podcast RSS feed. */
export const fetchFeed = onCall(
  { region: REGION, memory: "512MiB", timeoutSeconds: 60 },
  async (req) => {
    assertAllowed(req);
    const url = assertHttpUrl((req.data as { url?: unknown })?.url, "url");

    const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/xml, text/xml, */*" } });
    if (!res.ok) throw new HttpsError("unavailable", `Feed returned HTTP ${res.status}.`);
    const xml = await res.text();

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });
    let doc: Record<string, unknown>;
    try {
      doc = parser.parse(xml);
    } catch {
      throw new HttpsError("invalid-argument", "Could not parse feed XML.");
    }
    const rss = doc.rss as Record<string, unknown> | undefined;
    const channel = rss?.channel as Record<string, unknown> | undefined;
    if (!channel) throw new HttpsError("invalid-argument", "Not an RSS 2.0 podcast feed.");

    const items = asArray(channel.item as Record<string, unknown> | Record<string, unknown>[] | undefined);
    const episodes: FeedEpisode[] = [];
    for (const item of items) {
      const enclosure = asArray(item.enclosure as Record<string, string> | Record<string, string>[] | undefined)[0];
      const audioUrl = enclosure?.["@_url"];
      if (!audioUrl) continue;
      const desc = text(item["itunes:summary"]) ?? text(item.description) ?? "";
      episodes.push({
        title: text(item.title) ?? "Untitled",
        audioUrl,
        mimeType: enclosure["@_type"],
        pubDate: text(item.pubDate),
        durationSec: parseDuration(item["itunes:duration"]),
        description: stripHtml(desc).slice(0, 300),
      });
      if (episodes.length >= 200) break;
    }

    const image =
      (channel["itunes:image"] as Record<string, string> | undefined)?.["@_href"] ??
      text((channel.image as Record<string, unknown> | undefined)?.url);

    return {
      title: text(channel.title) ?? url.hostname,
      language: text(channel.language),
      image,
      episodes,
    };
  },
);

const EXT_BY_TYPE: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/webm": "webm",
};

function pickExtension(contentType: string | null, url: URL): string {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (EXT_BY_TYPE[ct]) return EXT_BY_TYPE[ct];
  const m = /\.([a-z0-9]{2,5})$/i.exec(url.pathname);
  if (m) return m[1].toLowerCase();
  return "mp3";
}

/**
 * Downloads a podcast episode into Storage. The Storage trigger then transcribes it.
 * Returns the new episode id immediately after the download completes.
 */
export const importEpisode = onCall(
  { region: REGION, memory: "1GiB", timeoutSeconds: 540 },
  async (req) => {
    const uid = assertAllowed(req);
    const data = (req.data ?? {}) as Record<string, unknown>;
    const audioUrl = assertHttpUrl(data.audioUrl, "audioUrl");
    const title = typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 300) : "Untitled";
    const language = typeof data.language === "string" && data.language ? data.language : "auto";
    const feedTitle = typeof data.feedTitle === "string" ? data.feedTitle.slice(0, 300) : undefined;
    const feedUrl = typeof data.feedUrl === "string" ? data.feedUrl.slice(0, 2000) : undefined;

    const res = await fetch(audioUrl, { headers: { "user-agent": USER_AGENT }, redirect: "follow" });
    if (!res.ok || !res.body) throw new HttpsError("unavailable", `Audio URL returned HTTP ${res.status}.`);
    const contentType = res.headers.get("content-type");
    const ext = pickExtension(contentType, audioUrl);
    const finalContentType = EXT_BY_TYPE[(contentType ?? "").split(";")[0].trim().toLowerCase()]
      ? (contentType as string).split(";")[0].trim()
      : `audio/${ext === "mp3" ? "mpeg" : ext}`;

    const episodeRef = db.collection(`users/${uid}/episodes`).doc();
    const episodeId = episodeRef.id;
    const audioPath = `users/${uid}/episodes/${episodeId}/audio.${ext}`;

    await episodeRef.set({
      title,
      language,
      status: "uploading",
      source: "rss",
      sourceUrl: audioUrl.toString(),
      feedTitle: feedTitle ?? null,
      feedUrl: feedUrl ?? null,
      audioPath,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info("Downloading episode", { episodeId, audioUrl: audioUrl.toString(), contentType });
    try {
      const file = bucket.file(audioPath);
      await pipeline(
        Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
        file.createWriteStream({
          contentType: finalContentType,
          resumable: false,
          metadata: { metadata: { uid, episodeId } },
        }),
      );
    } catch (err) {
      logger.error("Download failed", { episodeId, err: String(err) });
      await episodeRef.update({
        status: "error",
        error: `Download failed: ${String(err instanceof Error ? err.message : err).slice(0, 500)}`,
        updatedAt: FieldValue.serverTimestamp(),
      });
      throw new HttpsError("unavailable", "Failed to download the episode audio.");
    }

    return { episodeId };
  },
);
