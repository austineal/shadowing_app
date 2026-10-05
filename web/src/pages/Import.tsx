import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FolderSelect } from "../components/FolderSelect";
import { ShowMore } from "../components/ShowMore";
import { usePaged } from "../hooks/usePaged";
import { useEpisodes } from "../hooks/useEpisode";
import { LanguageSelect } from "../components/LanguageSelect";
import { useFolders, useSubscriptions } from "../hooks/useLibrary";
import { fetchFeed, importFeedEpisode, uploadEpisode, type FeedEpisode, type FeedResult } from "../lib/episodes";
import { subscribe } from "../lib/library";
import { ROLE_LABEL, guessColumns, hasHeader, parseCsv, readCards, uploadDeck, type Columns, type Role } from "../lib/deck";
import { formatDuration, titleFromFilename } from "../lib/format";
import { importedLookup } from "../lib/organise";
import { loadRecentFeeds, rememberFeed } from "../lib/settings";

const LANG_KEY = "shadowing.lastLanguage";

export default function Import({ uid }: { uid: string }) {
  const [tab, setTab] = useState<"upload" | "feed" | "deck">("upload");
  const [language, setLanguage] = useState(() => localStorage.getItem(LANG_KEY) ?? "fr");
  useEffect(() => localStorage.setItem(LANG_KEY, language), [language]);
  const { folders } = useFolders(uid);
  const [folderId, setFolderId] = useState("");

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
        <button className={tab === "deck" ? "active" : ""} onClick={() => setTab("deck")}>
          Card deck
        </button>
      </div>
      <div className="section">
        <div className="field">
          <label>Language</label>
          <LanguageSelect
            value={language}
            onChange={(v) => {
              setLanguage(v);
              setFolderId(""); // folders belong to a language
            }}
          />
        </div>
        {folders && folders.some((f) => language === "auto" || f.language === language) && (
          <div className="field">
            <label>Folder</label>
            <FolderSelect
              folders={folders}
              value={folderId}
              onChange={setFolderId}
              language={language === "auto" ? undefined : language}
            />
          </div>
        )}
        {tab === "upload" ? (
          <UploadForm uid={uid} language={language} folderId={folderId || null} />
        ) : tab === "deck" ? (
          <DeckForm uid={uid} language={language} folderId={folderId || null} />
        ) : (
          <FeedForm uid={uid} language={language} folderId={folderId || null} />
        )}
      </div>
    </div>
  );
}

function UploadForm({ uid, language, folderId }: { uid: string; language: string; folderId: string | null }) {
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
        folderId,
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

const ROLES: Role[] = ["audio", "text", "englishAudio", "english"];

/** A deck of audio flashcards: a CSV with a row per card, and the audio files it names. */
function DeckForm({ uid, language, folderId }: { uid: string; language: string; folderId: string | null }) {
  const nav = useNavigate();
  const [csv, setCsv] = useState<{ name: string; rows: string[][] } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  /** Columns chosen by hand; cleared when the CSV or files change, so the guess applies again. */
  const [chosen, setChosen] = useState<Columns | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string>();

  const names = useMemo(() => new Set(files.map((f) => f.name.toLowerCase())), [files]);
  const header = csv && hasHeader(csv.rows, names) ? csv.rows[0] : null;
  const body = csv ? csv.rows.slice(header ? 1 : 0) : [];
  const guessed = useMemo(() => {
    if (!csv) return null;
    const h = hasHeader(csv.rows, names) ? csv.rows[0] : null;
    return guessColumns(h, csv.rows.slice(h ? 1 : 0), names);
  }, [csv, names]);
  const cols = chosen ?? guessed;
  const read = cols ? readCards(body, cols, files, header ? 1 : 0) : null;
  const width = Math.max(header?.length ?? 0, ...body.slice(0, 50).map((r) => r.length));
  const columnName = (i: number) => header?.[i] || `Column ${i + 1}: ${body[0]?.[i] ?? ""}`.slice(0, 40);
  const withEnglish = read ? read.cards.filter((c) => c.englishAudio || c.english).length : 0;

  const submit = async () => {
    if (!read || read.cards.length === 0) return;
    setError(undefined);
    setProgress(0);
    try {
      const id = await uploadDeck(uid, { title, language, folderId, cards: read.cards, onProgress: setProgress });
      nav(`/episode/${id}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    }
  };

  if (language === "auto") return <p className="small muted">Choose the deck's language first.</p>;
  return (
    <div>
      <p className="small muted" style={{ marginTop: 0 }}>
        A CSV with a row per card (its audio file, the sentence, and optionally English audio and English text), and
        the audio files it names. The cards are joined into one recording and added to your drills, to learn card by card.
      </p>
      <div className="field">
        <label>Card list (CSV or TSV)</label>
        <input
          className="input"
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/plain"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            setChosen(null);
            if (!f) return setCsv(null);
            setCsv({ name: f.name, rows: parseCsv(await f.text()) });
            if (!title) setTitle(titleFromFilename(f.name));
          }}
        />
      </div>
      <div className="field">
        <label>Audio files</label>
        <input
          className="input"
          type="file"
          multiple
          accept="audio/*,.mp3,.m4a,.ogg,.opus,.wav,.flac"
          onChange={(e) => {
            setChosen(null);
            setFiles([...(e.target.files ?? [])]);
          }}
        />
      </div>
      <div className="field">
        <label>Title</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Deck title" />
      </div>
      {csv && cols && (
        <div className="field">
          <label>Columns</label>
          {ROLES.map((role) => (
            <div key={role} className="row" style={{ marginBottom: 6 }}>
              <span className="small" style={{ width: 110 }}>
                {ROLE_LABEL[role]}
              </span>
              <select
                className="input"
                value={cols[role] ?? ""}
                onChange={(e) => setChosen({ ...cols, [role]: e.target.value === "" ? null : Number(e.target.value) })}
              >
                <option value="">{role === "audio" || role === "text" ? "Choose…" : "None"}</option>
                {Array.from({ length: width }, (_, i) => (
                  <option key={i} value={i}>
                    {columnName(i)}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
      {read && (
        <div className="field small">
          <p style={{ margin: "0 0 6px" }}>
            <b>{read.cards.length}</b> {read.cards.length === 1 ? "card" : "cards"}
            {read.cards.length > 0 && withEnglish < read.cards.length && (
              <span className="muted"> · {read.cards.length - withEnglish} without English (Claude can translate them)</span>
            )}
          </p>
          {read.cards.slice(0, 3).map((c, i) => (
            <div key={i} className="muted" style={{ marginBottom: 4 }}>
              {c.text}
              {c.english && <span> — {c.english}</span>}
              <span>
                {" "}
                ({c.audio.name}
                {c.englishAudio ? `, ${c.englishAudio.name}` : ""})
              </span>
            </div>
          ))}
          {read.skipped.length > 0 && (
            <p className="error" style={{ margin: "6px 0 0" }}>
              {read.skipped.length} {read.skipped.length === 1 ? "row" : "rows"} left out:{" "}
              {read.skipped
                .slice(0, 3)
                .map((s) => `row ${s.row}, ${s.why}`)
                .join("; ")}
              {read.skipped.length > 3 ? "; …" : ""}
            </p>
          )}
        </div>
      )}
      {progress !== null && (
        <div className="field">
          <div className="progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <span className="small muted">Uploading… {Math.round(progress * 100)}%</span>
        </div>
      )}
      {error && <p className="error small" style={{ marginBottom: 10 }}>{error}</p>}
      <button className="btn primary" disabled={!read?.cards.length || progress !== null} onClick={() => void submit()}>
        Upload deck
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

function FeedForm({ uid, language, folderId }: { uid: string; language: string; folderId: string | null }) {
  const nav = useNavigate();
  const [url, setUrl] = useState("");
  const [feed, setFeed] = useState<FeedResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const { subscriptions } = useSubscriptions(uid);
  const [subscribing, setSubscribing] = useState(false);
  const subscribedUrls = new Set(subscriptions?.map((s) => s.feedUrl));
  const recent = loadRecentFeeds().filter((f) => !subscribedUrls.has(f.url));
  // The URL the current feed was loaded from (the input may since have been edited).
  const [feedUrl, setFeedUrl] = useState("");
  const currentSub = subscriptions?.find((s) => s.feedUrl === feedUrl);
  const paged = usePaged("import-feed", feed?.episodes ?? []);
  const { episodes } = useEpisodes(uid);
  const findImported = useMemo(() => importedLookup(episodes ?? [], feedUrl), [episodes, feedUrl]);

  const load = async (u: string) => {
    setUrl(u);
    setError(undefined);
    setBusy(true);
    setFeed(null);
    try {
      const result = await fetchFeed(u.trim());
      setFeed(result);
      setFeedUrl(u.trim());
      rememberFeed({ url: u.trim(), title: result.title });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async ({ audioUrl, title, guid }: FeedEpisode) => {
    setImporting(audioUrl);
    setError(undefined);
    try {
      const id = await importFeedEpisode({ audioUrl, title, guid, language, folderId, feedTitle: feed?.title, feedUrl });
      nav(`/episode/${id}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setImporting(null);
    }
  };

  const doSubscribe = async () => {
    if (!feed) return;
    setSubscribing(true);
    setError(undefined);
    try {
      await subscribe(uid, feedUrl, feed, language);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubscribing(false);
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
      {subscriptions && subscriptions.length > 0 && !feed && (
        <div className="field">
          <label>Your podcasts</label>
          <div className="row wrap">
            {subscriptions.map((s) => (
              <Link key={s.id} to={`/podcast/${s.id}`} className="btn small">
                {s.title}
              </Link>
            ))}
          </div>
        </div>
      )}
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
          <div className="row" style={{ margin: "6px 0 10px" }}>
            <h2 style={{ fontSize: "1rem", flex: 1 }}>
              {feed.title} <span className="muted small">· {feed.episodes.length} episodes</span>
            </h2>
            {currentSub ? (
              <Link to={`/podcast/${currentSub.id}`} className="btn small">
                ✓ Subscribed
              </Link>
            ) : (
              <button
                className="btn small"
                disabled={subscribing || subscriptions === undefined}
                onClick={() => void doSubscribe()}
                title="Keep this podcast in your library and see new episodes as they come out"
              >
                + Subscribe
              </button>
            )}
          </div>
          <div className="list" style={{ padding: 0 }}>
            {paged.shown.map((ep) => {
              const imported = findImported(ep);
              return (
                <div key={ep.audioUrl} className="card">
                  <div className="body">
                    <div className="title">{ep.title}</div>
                    <div className="meta">
                      {ep.pubDate ? <span>{new Date(ep.pubDate).toLocaleDateString()}</span> : null}
                      {ep.durationSec ? <span>{formatDuration(ep.durationSec)}</span> : null}
                    </div>
                    {ep.description ? <p className="small muted feed-desc">{ep.description}</p> : null}
                  </div>
                  {imported ? (
                    <Link to={`/episode/${imported.id}`} className="btn small">
                      Open
                    </Link>
                  ) : (
                    <button
                      className="btn small primary"
                      disabled={importing !== null || episodes === undefined}
                      onClick={() => void doImport(ep)}
                    >
                      {importing === ep.audioUrl ? <span className="spinner" style={{ width: 16, height: 16 }} /> : "Import"}
                    </button>
                  )}
                </div>
              );
            })}
            <ShowMore paged={paged} />
          </div>
        </div>
      )}
    </div>
  );
}
