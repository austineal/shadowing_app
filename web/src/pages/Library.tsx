import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { OfflineButton } from "../components/OfflineButton";
import { useEpisodes } from "../hooks/useEpisode";
import { useFolders, useSubscriptions } from "../hooks/useLibrary";
import { signOut } from "../hooks/useAuth";
import { deleteEpisode, updateEpisode } from "../lib/episodes";
import { createFolder, deleteFolder, refreshStaleSubscriptions, renameFolder } from "../lib/library";
import { filterEpisodes, listShows, parseFilter, type LibraryFilter } from "../lib/organise";
import { formatBytes, formatDate, formatDuration } from "../lib/format";
import { languageLabel } from "../lib/languages";
import { storageUsage, useOnline } from "../lib/offline";
import type { Episode, Folder, Subscription } from "../types";

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
  const { folders, error: foldersError } = useFolders(uid);
  const { subscriptions, error: subsError } = useSubscriptions(uid);
  const online = useOnline();
  const [params, setParams] = useSearchParams();
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [usageTick, setUsageTick] = useState(0);

  useEffect(() => {
    void storageUsage().then(setUsage);
  }, [episodes?.length, usageTick]);

  // Look for new podcast episodes once per visit; stale feeds only, so quick back-and-forth costs nothing.
  const refreshed = useRef(false);
  useEffect(() => {
    if (!online || !subscriptions?.length || refreshed.current) return;
    refreshed.current = true;
    void refreshStaleSubscriptions(uid, subscriptions);
  }, [online, subscriptions, uid]);

  const shows = useMemo(() => listShows(episodes ?? []), [episodes]);
  let filter = parseFilter(params.get("f"));
  // A folder or show that has gone away (deleted, or last episode removed) falls back to everything.
  if (
    (filter.startsWith("folder:") && folders && !folders.some((f) => `folder:${f.id}` === filter)) ||
    (filter.startsWith("show:") && episodes && !shows.some((s) => `show:${s.key}` === filter))
  ) {
    filter = "all";
  }
  const setFilter = (f: LibraryFilter) => setParams(f === "all" ? {} : { f }, { replace: true });
  const visible = episodes && folders ? filterEpisodes(episodes, folders, filter) : undefined;
  const currentFolder = filter.startsWith("folder:") ? folders?.find((f) => `folder:${f.id}` === filter) : undefined;

  const addFolder = async () => {
    const name = prompt("New folder name")?.trim();
    if (name) setFilter(`folder:${await createFolder(uid, name)}`);
  };

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

      {(error ?? foldersError ?? subsError) && <p className="error section">{error ?? foldersError ?? subsError}</p>}

      {subscriptions && subscriptions.length > 0 && <PodcastStrip subscriptions={subscriptions} />}

      {episodes && episodes.length > 0 && folders && (
        <div className="chips" role="tablist" aria-label="Filter episodes">
          <Chip active={filter === "all"} onClick={() => setFilter("all")}>
            All <span className="count">{episodes.length}</span>
          </Chip>
          {folders.length > 0 && (
            <Chip active={filter === "unfiled"} onClick={() => setFilter("unfiled")}>
              Unfiled
            </Chip>
          )}
          {folders.map((f) => (
            <Chip key={f.id} active={filter === `folder:${f.id}`} onClick={() => setFilter(`folder:${f.id}`)}>
              📁 {f.name}
            </Chip>
          ))}
          {shows.map((s) => (
            <Chip key={s.key} active={filter === `show:${s.key}`} onClick={() => setFilter(`show:${s.key}`)}>
              🎙 {s.title} <span className="count">{s.count}</span>
            </Chip>
          ))}
          <button className="chip add" onClick={() => void addFolder()}>
            + Folder
          </button>
        </div>
      )}

      {currentFolder && (
        <div className="row folder-tools">
          <span className="small muted">{currentFolder.name}</span>
          <span className="spacer" />
          <button
            className="btn ghost small"
            onClick={() => {
              const name = prompt("Rename folder", currentFolder.name)?.trim();
              if (name && name !== currentFolder.name) void renameFolder(uid, currentFolder.id, name);
            }}
          >
            Rename
          </button>
          <button
            className="btn ghost small danger"
            onClick={() => {
              if (confirm(`Delete the folder "${currentFolder.name}"? Its episodes stay in your library, unfiled.`)) {
                setFilter("all");
                void deleteFolder(uid, currentFolder.id);
              }
            }}
          >
            Delete folder
          </button>
        </div>
      )}

      {(episodes === undefined || folders === undefined) && (
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
      {visible && episodes!.length > 0 && visible.length === 0 && (
        <p className="empty small">{currentFolder ? "This folder is empty. Move episodes here from their ⋯ menu." : "Nothing here."}</p>
      )}
      {visible && visible.length > 0 && (
        <div className="list">
          {visible.map((ep) => (
            <EpisodeCard
              key={ep.id}
              uid={uid}
              ep={ep}
              folders={folders!}
              onStorageChange={() => setUsageTick((t) => t + 1)}
            />
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

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`chip${active ? " active" : ""}`} role="tab" aria-selected={active} onClick={onClick}>
      {children}
    </button>
  );
}

function PodcastStrip({ subscriptions }: { subscriptions: Subscription[] }) {
  return (
    <div className="podcasts">
      {subscriptions.map((s) => (
        <Link key={s.id} to={`/podcast/${s.id}`} className="podcast-tile" title={s.checkError ?? s.title}>
          {s.image ? <img src={s.image} alt="" loading="lazy" /> : <span className="art-fallback">🎙</span>}
          {s.newCount > 0 && <span className="badge">{s.newCount > 99 ? "99+" : s.newCount}</span>}
          <span className="name">{s.title}</span>
        </Link>
      ))}
    </div>
  );
}

function EpisodeCard({
  uid,
  ep,
  folders,
  onStorageChange,
}: {
  uid: string;
  ep: Episode;
  folders: Folder[];
  onStorageChange: () => void;
}) {
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const folder = folders.find((f) => f.id === ep.folderId);

  return (
    <div
      className="card"
      role="button"
      tabIndex={0}
      onClick={() => !editing && nav(`/episode/${ep.id}`)}
      onKeyDown={(e) => e.key === "Enter" && !editing && e.target === e.currentTarget && nav(`/episode/${ep.id}`)}
    >
      <div className="body">
        <div className="title">{ep.title}</div>
        <div className="meta">
          <StatusPill ep={ep} />
          <span>{languageLabel(ep.language === "auto" ? ep.detectedLanguage : ep.language)}</span>
          {ep.durationSec ? <span>{formatDuration(ep.durationSec)}</span> : null}
          {ep.feedTitle ? <span>{ep.feedTitle}</span> : null}
          {folder ? <span>📁 {folder.name}</span> : null}
          <span>{formatDate(ep.createdAt?.toDate())}</span>
        </div>
        {editing ? (
          <EpisodeEditor uid={uid} ep={ep} folders={folders} onDone={() => setEditing(false)} onDeleted={onStorageChange} />
        ) : (
          <div className="row" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
            <OfflineButton uid={uid} episode={ep} onChange={onStorageChange} />
          </div>
        )}
      </div>
      {!editing && (
        <button
          className="btn ghost small"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          aria-label="Edit episode"
          title="Rename, move or delete"
        >
          ⋯
        </button>
      )}
    </div>
  );
}

function EpisodeEditor({
  uid,
  ep,
  folders,
  onDone,
  onDeleted,
}: {
  uid: string;
  ep: Episode;
  folders: Folder[];
  onDone: () => void;
  onDeleted: () => void;
}) {
  const [title, setTitle] = useState(ep.title);
  const [folderId, setFolderId] = useState(folders.some((f) => f.id === ep.folderId) ? ep.folderId! : "");
  const [error, setError] = useState<string>();

  const save = async () => {
    const patch: Partial<Episode> = {};
    if (title.trim() && title.trim() !== ep.title) patch.title = title.trim();
    if ((folderId || null) !== (ep.folderId ?? null)) patch.folderId = folderId || null;
    try {
      if (Object.keys(patch).length) await updateEpisode(uid, ep.id, patch);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="editor" onClick={(e) => e.stopPropagation()}>
      <div className="field">
        <label>Title</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
      </div>
      <div className="field">
        <label>Folder</label>
        <select className="input" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">Unfiled</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button className="btn primary small" onClick={() => void save()}>
          Save
        </button>
        <button className="btn small" onClick={onDone}>
          Cancel
        </button>
        <span className="spacer" />
        <button
          className="btn ghost small danger"
          onClick={() => {
            if (confirm(`Delete "${ep.title}"? This removes the audio and transcript.`)) {
              void deleteEpisode(uid, ep).then(onDeleted);
            }
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
