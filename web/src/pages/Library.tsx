import { Link, useNavigate } from "react-router-dom";
import { useEpisodes } from "../hooks/useEpisode";
import { signOut } from "../hooks/useAuth";
import { deleteEpisode } from "../lib/episodes";
import { formatDate, formatDuration } from "../lib/format";
import { languageLabel } from "../lib/languages";
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

  return (
    <div className="page">
      <header className="topbar">
        <h1>Shadowing</h1>
        <Link to="/import" className="btn primary small">
          + Import
        </Link>
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
              </div>
              <button
                className="btn ghost small danger"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${ep.title}"? This removes the audio and transcript.`)) {
                    void deleteEpisode(uid, ep.id);
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
    </div>
  );
}
