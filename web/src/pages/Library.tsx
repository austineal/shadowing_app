import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DrillToday } from "../components/DrillToday";
import { FolderSelect } from "../components/FolderSelect";
import { OfflineButton } from "../components/OfflineButton";
import { useEpisodes } from "../hooks/useEpisode";
import { useFolders, useSubscriptions } from "../hooks/useLibrary";
import { signOut } from "../hooks/useAuth";
import { deleteEpisode, updateEpisode } from "../lib/episodes";
import { createFolder, deleteFolder, refreshStaleSubscriptions, renameFolder } from "../lib/library";
import { buildLibraryTree, episodeLanguage, type LibraryNode } from "../lib/organise";
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

const EXPANDED_KEY = "shadowing.libraryExpanded";

/** Which tree nodes are open, remembered per device. Until the user toggles anything, languages start open. */
function useExpanded(defaultOpen: string[]) {
  const [stored, setStored] = useState<string[] | null>(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      return raw ? (JSON.parse(raw) as string[]) : null;
    } catch {
      return null;
    }
  });
  const open = new Set(stored ?? defaultOpen);
  const toggle = (id: string) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    const list = [...next];
    setStored(list);
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  };
  return { open, toggle };
}

export default function Library({ uid }: { uid: string }) {
  const { episodes, error } = useEpisodes(uid);
  const { folders, error: foldersError } = useFolders(uid);
  const { subscriptions, error: subsError } = useSubscriptions(uid);
  const online = useOnline();
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

  const tree = useMemo(
    () => (episodes && folders ? buildLibraryTree(episodes, folders) : undefined),
    [episodes, folders],
  );
  const { open, toggle } = useExpanded(tree?.map((n) => n.id) ?? []);
  const subByFeed = useMemo(() => new Map(subscriptions?.map((s) => [s.feedUrl, s.id])), [subscriptions]);
  const ctx: TreeContext = {
    uid,
    folders: folders ?? [],
    subByFeed,
    open,
    toggle,
    onStorageChange: () => setUsageTick((t) => t + 1),
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

      <DrillToday uid={uid} />

      {subscriptions && subscriptions.length > 0 && <PodcastStrip subscriptions={subscriptions} />}

      {tree === undefined && (
        <div className="center">
          <div className="spinner" />
        </div>
      )}
      {tree && tree.length === 0 && (
        <div className="empty">
          <p>No episodes yet.</p>
          <p className="small" style={{ marginTop: 8 }}>
            Import a podcast episode or upload an audio file to get started.
          </p>
        </div>
      )}
      {tree && tree.length > 0 && (
        <div className="tree">
          {tree.map((n) => (
            <TreeBranch key={n.id} node={n} depth={0} ctx={ctx} />
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

interface TreeContext {
  uid: string;
  folders: Folder[];
  subByFeed: Map<string, string>;
  open: Set<string>;
  toggle: (id: string) => void;
  onStorageChange: () => void;
}

const ICONS: Record<LibraryNode["kind"], string> = { language: "🌐", folder: "📁", show: "🎙" };

function TreeBranch({ node, depth, ctx }: { node: LibraryNode; depth: number; ctx: TreeContext }) {
  const expanded = ctx.open.has(node.id);
  const [managing, setManaging] = useState(false);
  const subId = node.feedUrl ? ctx.subByFeed.get(node.feedUrl) : undefined;
  const indent = { "--depth": depth } as CSSProperties;
  const folder = node.folder;

  const newFolder = async () => {
    const name = prompt(`New ${languageLabel(node.language)} folder`)?.trim();
    if (!name) return;
    const id = await createFolder(ctx.uid, name, node.language);
    if (!ctx.open.has(`folder:${id}`)) ctx.toggle(`folder:${id}`);
  };

  return (
    <div className={`branch ${node.kind}`}>
      <div className="tree-row" style={indent}>
        <button className="tree-toggle" aria-expanded={expanded} onClick={() => ctx.toggle(node.id)}>
          <span className="caret" aria-hidden>
            ▸
          </span>
          <span aria-hidden>{ICONS[node.kind]}</span>
          <span className="label">{node.label}</span>
          <span className="count">{node.count}</span>
        </button>
        {subId && (
          <Link to={`/podcast/${subId}`} className="btn ghost small" title="Open podcast feed">
            Feed ›
          </Link>
        )}
        {folder && (
          <button
            className="btn ghost small"
            aria-label={`Manage folder ${folder.name}`}
            aria-expanded={managing}
            onClick={() => setManaging((m) => !m)}
          >
            ⋯
          </button>
        )}
      </div>

      {folder && managing && (
        <div className="row tree-actions" style={indent}>
          <button
            className="btn small"
            onClick={() => {
              const name = prompt("Rename folder", folder.name)?.trim();
              if (name && name !== folder.name) void renameFolder(ctx.uid, folder.id, name);
              setManaging(false);
            }}
          >
            Rename
          </button>
          <button
            className="btn small danger"
            onClick={() => {
              if (confirm(`Delete the folder "${folder.name}"? Its episodes stay in your library.`)) {
                void deleteFolder(ctx.uid, folder.id);
              }
            }}
          >
            Delete folder
          </button>
        </div>
      )}

      {expanded && (
        <>
          {node.children.map((c) => (
            <TreeBranch key={c.id} node={c} depth={depth + 1} ctx={ctx} />
          ))}
          {node.episodes.length > 0 && (
            <div className="list tree-episodes" style={{ "--depth": depth + 1 } as CSSProperties}>
              {node.episodes.map((ep) => (
                <EpisodeCard key={ep.id} ep={ep} parent={node} ctx={ctx} />
              ))}
            </div>
          )}
          {node.kind === "folder" && node.count === 0 && (
            <p className="small muted tree-note" style={{ "--depth": depth + 1 } as CSSProperties}>
              Empty. Move episodes here from their ⋯ menu.
            </p>
          )}
          {node.kind === "language" && node.language !== "unknown" && (
            <div className="tree-row" style={{ "--depth": depth + 1 } as CSSProperties}>
              <button className="tree-toggle add" onClick={() => void newFolder()}>
                + New folder
              </button>
            </div>
          )}
        </>
      )}
    </div>
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

function EpisodeCard({ ep, parent, ctx }: { ep: Episode; parent: LibraryNode; ctx: TreeContext }) {
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const lang = episodeLanguage(ep);

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
          {/* The tree already says the language and show; repeat them only where a folder mixes things. */}
          {lang !== parent.language && lang !== "unknown" ? <span>{languageLabel(lang)}</span> : null}
          {ep.durationSec ? <span>{formatDuration(ep.durationSec)}</span> : null}
          {parent.kind === "folder" && ep.feedTitle ? <span>{ep.feedTitle}</span> : null}
          <span>{formatDate(ep.createdAt?.toDate())}</span>
        </div>
        {editing ? (
          <EpisodeEditor
            uid={ctx.uid}
            ep={ep}
            folders={ctx.folders}
            onDone={() => setEditing(false)}
            onDeleted={ctx.onStorageChange}
          />
        ) : (
          <div className="row" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
            <OfflineButton uid={ctx.uid} episode={ep} onChange={ctx.onStorageChange} />
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
        <FolderSelect folders={folders} value={folderId} onChange={setFolderId} />
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
