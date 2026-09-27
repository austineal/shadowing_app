import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { LanguageSelect } from "../components/LanguageSelect";
import { useEpisodes } from "../hooks/useEpisode";
import { useSubscriptions } from "../hooks/useLibrary";
import { fetchFeed, importFeedEpisode, type FeedResult } from "../lib/episodes";
import { recordFeedCheck, setSubscriptionLanguage, unsubscribe } from "../lib/library";
import { pubTime, showKey } from "../lib/organise";
import { formatDuration } from "../lib/format";
import { useOnline } from "../lib/offline";
import type { Episode } from "../types";

/** One subscribed show: its feed, with new and already-imported episodes marked. */
export default function Podcast({ uid }: { uid: string }) {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const online = useOnline();
  const { subscriptions, error: subsError } = useSubscriptions(uid);
  const { episodes } = useEpisodes(uid);
  const sub = subscriptions?.find((s) => s.id === id);

  // seenUpTo is captured with the feed because opening the show marks everything seen,
  // but the "New" labels should still show for this visit.
  const [loaded, setLoaded] = useState<{ feed: FeedResult; seenUpTo: number } | null>(null);
  const feed = loaded?.feed;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!sub || !online || loadedFor.current === sub.id) return;
    loadedFor.current = sub.id;
    const seenUpTo = sub.seenUpTo;
    setLoading(true);
    setError(undefined);
    fetchFeed(sub.feedUrl)
      .then((f) => {
        setLoaded({ feed: f, seenUpTo });
        void recordFeedCheck(uid, sub, f, true);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [sub, online, uid]);

  const bySourceUrl = useMemo(() => {
    const m = new Map<string, Episode>();
    for (const ep of episodes ?? []) if (ep.sourceUrl) m.set(ep.sourceUrl, ep);
    return m;
  }, [episodes]);

  if (subsError) return <Shell title="Error"><p className="error section">{subsError}</p></Shell>;
  if (subscriptions === undefined) {
    return (
      <Shell title="Loading…">
        <div className="center">
          <div className="spinner" />
        </div>
      </Shell>
    );
  }
  if (!sub) {
    return (
      <Shell title="Not subscribed">
        <p className="section muted">You're not subscribed to this podcast any more.</p>
      </Shell>
    );
  }

  const doImport = async (audioUrl: string, title: string) => {
    setImporting((s) => new Set(s).add(audioUrl));
    setError(undefined);
    try {
      await importFeedEpisode({ audioUrl, title, language: sub.language, feedTitle: sub.title, feedUrl: sub.feedUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting((s) => {
        const next = new Set(s);
        next.delete(audioUrl);
        return next;
      });
    }
  };

  const inLibrary = (episodes ?? []).filter((ep) => showKey(ep) === sub.feedUrl);

  return (
    <Shell
      title={sub.title}
      right={
        <button
          className="btn ghost small danger"
          onClick={() => {
            if (confirm(`Unsubscribe from "${sub.title}"? Episodes you've imported stay in your library.`)) {
              void unsubscribe(uid, sub.id).then(() => nav("/", { replace: true }));
            }
          }}
        >
          Unsubscribe
        </button>
      }
    >
      <div className="section podcast-head">
        {sub.image ? <img src={sub.image} alt="" /> : null}
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label>Language for imports</label>
          <LanguageSelect value={sub.language} onChange={(v) => void setSubscriptionLanguage(uid, sub.id, v)} />
        </div>
      </div>

      {error && <p className="error small section">{error}</p>}
      {loading && (
        <div className="center">
          <div className="spinner" />
        </div>
      )}

      {!online && !feed && (
        <>
          <p className="section small muted">You're offline. Connect to see the latest episodes.</p>
          {inLibrary.length > 0 && (
            <div className="list">
              {inLibrary.map((ep) => (
                <Link key={ep.id} to={`/episode/${ep.id}`} className="card">
                  <div className="body">
                    <div className="title">{ep.title}</div>
                    <div className="meta">{ep.durationSec ? <span>{formatDuration(ep.durationSec)}</span> : null}</div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}

      {feed && (
        <div className="list">
          {feed.episodes.map((fe) => {
            const imported = bySourceUrl.get(fe.audioUrl);
            const isNew = pubTime(fe.pubDate) > loaded!.seenUpTo;
            return (
              <div key={fe.audioUrl} className="card">
                <div className="body">
                  <div className="title">{fe.title}</div>
                  <div className="meta">
                    {isNew && !imported && <span className="pill ready">New</span>}
                    {fe.pubDate ? <span>{new Date(fe.pubDate).toLocaleDateString()}</span> : null}
                    {fe.durationSec ? <span>{formatDuration(fe.durationSec)}</span> : null}
                  </div>
                  {fe.description ? (
                    <p className="small muted" style={{ marginTop: 4 }}>
                      {fe.description}
                    </p>
                  ) : null}
                </div>
                {imported ? (
                  <Link to={`/episode/${imported.id}`} className="btn small">
                    Open
                  </Link>
                ) : (
                  <button
                    className="btn small primary"
                    disabled={importing.has(fe.audioUrl) || !online}
                    onClick={() => void doImport(fe.audioUrl, fe.title)}
                  >
                    {importing.has(fe.audioUrl) ? <span className="spinner" style={{ width: 16, height: 16 }} /> : "Import"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}

function Shell({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="btn ghost icon" aria-label="Back">
          ‹
        </Link>
        <h1>{title}</h1>
        {right}
      </header>
      {children}
    </div>
  );
}
