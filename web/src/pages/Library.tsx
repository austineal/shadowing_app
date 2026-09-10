import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { OfflineButton } from "../components/OfflineButton";
import { useEpisodes } from "../hooks/useEpisode";
import { signOut } from "../hooks/useAuth";
import { deleteEpisode } from "../lib/episodes";
import { formatBytes, formatDate, formatDuration } from "../lib/format";
import { languageLabel } from "../lib/languages";
import { storageUsage, useOnline } from "../lib/offline";
import type { Episode } from "../types";

function StatusPill({ ep }: { ep: Episode }) {
  switch (ep.status) {
    case "ready":
      return <span className="pill ready">Ready</span>;
    case "error":
      return <span className="pill error">Error</span>;
    case "transcribing":
      return <span className="pill busy">Transcribing…</span>;
    default:
      return <span className="pill busy">Uploading…</span>;
  }
}

export default function Library({ uid }: { uid: string }) {
  const { episodes, error } = useEpisodes(uid);
  const nav = useNavigate();
  const online = useOnline();
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [usageTick, setUsageTick] = useState(0);

  useEffect(() => {
    void storageUsage().then(setUsage);
  }, [episodes?.length, usageTick]);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Shadowing</h1>
        {!online && <span className="pill busy">Offline</span>}
        {online ? (
          <Link to="/import" className="btn primary small">
            + Import
          </Link>
        ) : (
          <button className="btn primary small" disabled title="Importing needs a connection">
            + Import
          </button>
        )}
        <button className="btn ghost small" onClick={() => void signOut()} title="Sign out">
          Sign out
        </button>
      </header>

      {error && <p className="error section">{error}</p>}
      {episodes === undefined && (
        <div className="center">
          <div className="spinner" />
        </div>
      )}
      {episodes && episodes.length === 0 && (
        <div className="empty">
          <p>No episodes yet.</p>
          <p className="small" style={{ marginTop: 8 }}>
            Import a podcast episode or upload an audio file to get started.
          </p>
        </div>
      )}
      {episodes && episodes.length > 0 && (
        <div className="list">
          {episodes.map((ep) => (
            <div key={ep.id} className="card" role="button" tabIndex={0} onClick={() => nav(`/episode/${ep.id}`)}>
              <div className="body">
                <div className="title">{ep.title}</div>
                <div className="meta">
                  <StatusPill ep={ep} />
                  <span>{languageLabel(ep.language === "auto" ? ep.detectedLanguage : ep.language)}</span>
                  {ep.durationSec ? <span>{formatDuration(ep.durationSec)}</span> : null}
                  {ep.feedTitle ? <span>{ep.feedTitle}</span> : null}
                  <span>{formatDate(ep.createdAt?.toDate())}</span>
                </div>
                <div className="row" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                  <OfflineButton uid={uid} episode={ep} onChange={() => setUsageTick((t) => t + 1)} />
                </div>
              </div>
              <button
                className="btn ghost small danger"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${ep.title}"? This removes the audio and transcript.`)) {
                    void deleteEpisode(uid, ep).then(() => setUsageTick((t) => t + 1));
                  }
                }}
                aria-label="Delete episode"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {usage && usage.usage > 0 && (
        <p className="small muted section" style={{ textAlign: "center" }}>
          Offline storage used on this device: {formatBytes(usage.usage)}
          {usage.quota ? ` of ${formatBytes(usage.quota)} available` : ""}
        </p>
      )}
    </div>
  );
}
