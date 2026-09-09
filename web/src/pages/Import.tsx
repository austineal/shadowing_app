import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchFeed, importFeedEpisode, uploadEpisode, type FeedResult } from "../lib/episodes";
import { formatDuration, titleFromFilename } from "../lib/format";
import { LANGUAGES } from "../lib/languages";
import { loadRecentFeeds, rememberFeed } from "../lib/settings";

const LANG_KEY = "shadowing.lastLanguage";

function LanguageSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

export default function Import({ uid }: { uid: string }) {
  const [tab, setTab] = useState<"upload" | "feed">("upload");
  const [language, setLanguage] = useState(() => localStorage.getItem(LANG_KEY) ?? "fr");
  useEffect(() => localStorage.setItem(LANG_KEY, language), [language]);

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="btn ghost icon" aria-label="Back">
          ‹
        </Link>
        <h1>Import</h1>
      </header>
      <div className="tabs">
        <button className={tab === "upload" ? "active" : ""} onClick={() => setTab("upload")}>
          Upload file
        </button>
        <button className={tab === "feed" ? "active" : ""} onClick={() => setTab("feed")}>
          Podcast feed
        </button>
      </div>
      <div className="section">
        <div className="field">
          <label>Language</label>
          <LanguageSelect value={language} onChange={setLanguage} />
        </div>
        {tab === "upload" ? <UploadForm uid={uid} language={language} /> : <FeedForm language={language} />}
      </div>
    </div>
  );
}

function UploadForm({ uid, language }: { uid: string; language: string }) {
  const nav = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const transcriptFileRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!file) return;
    setError(undefined);
    setProgress(0);
    try {
      const id = await uploadEpisode(uid, {
        file,
        title: title || titleFromFilename(file.name),
        language,
        transcriptText: transcript.trim() || undefined,
        onProgress: setProgress,
      });
      nav(`/episode/${id}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    }
  };

  return (
    <div>
      <div className="field">
        <label>Audio file</label>
        <input
          className="input"
          type="file"
          accept="audio/*,.mp3,.m4a,.ogg,.opus,.wav,.flac"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            if (f && !title) setTitle(titleFromFilename(f.name));
          }}
        />
      </div>
      <div className="field">
        <label>Title</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Episode title" />
      </div>
      <div className="field">
        <div className="row">
          <label>Transcript (optional)</label>
          <span className="spacer" />
          <button className="btn ghost small" onClick={() => transcriptFileRef.current?.click()}>
            Load .txt
          </button>
          <input
            ref={transcriptFileRef}
            type="file"
            accept=".txt,.srt,.vtt,text/plain"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setTranscript(stripSubtitleMarkup(await f.text()));
            }}
          />
        </div>
        <textarea
          className="input"
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="Paste the transcript here if you have one. It will be aligned to the audio; otherwise the audio is transcribed automatically."
        />
      </div>
      {progress !== null && (
        <div className="field">
          <div className="progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <span className="small muted">Uploading… {Math.round(progress * 100)}%</span>
        </div>
      )}
      {error && <p className="error small" style={{ marginBottom: 10 }}>{error}</p>}
      <button className="btn primary" disabled={!file || progress !== null} onClick={() => void submit()}>
        Upload and transcribe
      </button>
    </div>
  );
}

/** Reduces .srt/.vtt content to plain text so it aligns like a transcript. */
function stripSubtitleMarkup(text: string): string {
  if (!/-->/.test(text)) return text;
  return text
    .split(/\r?\n/)
    .filter((l) => !/-->/.test(l) && !/^\d+$/.test(l.trim()) && !/^WEBVTT/.test(l) && !/^NOTE/.test(l))
    .map((l) => l.replace(/<[^>]+>/g, ""))
    .join("\n")
    .replace(/\n{2,}/g, "\n");
}

function FeedForm({ language }: { language: string }) {
  const nav = useNavigate();
  const [url, setUrl] = useState("");
  const [feed, setFeed] = useState<FeedResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const recent = loadRecentFeeds();

  const load = async (u: string) => {
    setUrl(u);
    setError(undefined);
    setBusy(true);
    setFeed(null);
    try {
      const result = await fetchFeed(u.trim());
      setFeed(result);
      rememberFeed({ url: u.trim(), title: result.title });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (audioUrl: string, title: string) => {
    setImporting(audioUrl);
    setError(undefined);
    try {
      const id = await importFeedEpisode({ audioUrl, title, language, feedTitle: feed?.title, feedUrl: url.trim() });
      nav(`/episode/${id}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setImporting(null);
    }
  };

  return (
    <div>
      <div className="field">
        <label>RSS feed URL</label>
        <div className="row">
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/feed.xml"
            inputMode="url"
            onKeyDown={(e) => e.key === "Enter" && url && void load(url)}
          />
          <button className="btn primary" disabled={!url || busy} onClick={() => void load(url)}>
            Load
          </button>
        </div>
      </div>
      {recent.length > 0 && !feed && (
        <div className="field">
          <label>Recent feeds</label>
          <div className="row wrap">
            {recent.map((f) => (
              <button key={f.url} className="btn small" onClick={() => void load(f.url)}>
                {f.title}
              </button>
            ))}
          </div>
        </div>
      )}
      {busy && (
        <div className="center">
          <div className="spinner" />
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      {feed && (
        <div>
          <h2 style={{ fontSize: "1rem", margin: "6px 0 10px" }}>
            {feed.title} <span className="muted small">· {feed.episodes.length} episodes</span>
          </h2>
          <div className="list" style={{ padding: 0 }}>
            {feed.episodes.map((ep) => (
              <div key={ep.audioUrl} className="card">
                <div className="body">
                  <div className="title">{ep.title}</div>
                  <div className="meta">
                    {ep.pubDate ? <span>{new Date(ep.pubDate).toLocaleDateString()}</span> : null}
                    {ep.durationSec ? <span>{formatDuration(ep.durationSec)}</span> : null}
                  </div>
                  {ep.description ? <p className="small muted" style={{ marginTop: 4 }}>{ep.description}</p> : null}
                </div>
                <button
                  className="btn small primary"
                  disabled={importing !== null}
                  onClick={() => void doImport(ep.audioUrl, ep.title)}
                >
                  {importing === ep.audioUrl ? <span className="spinner" style={{ width: 16, height: 16 }} /> : "Import"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
