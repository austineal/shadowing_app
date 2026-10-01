import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { DrillToday } from "../components/DrillToday";
import { FolderSelect } from "../components/FolderSelect";
import { OfflineButton } from "../components/OfflineButton";
import { ShowMore } from "../components/ShowMore";
import { usePaged } from "../hooks/usePaged";
import { useEpisodes } from "../hooks/useEpisode";
import { useDrillPrefs, useDrills, useRecentSessions } from "../hooks/useDrills";
import { useFolders, useSubscriptions } from "../hooks/useLibrary";
import { signOut } from "../hooks/useAuth";
import { coverageByEpisode, formatCoverage, type Coverage } from "../lib/drill/coverage";
import { deleteEpisode, updateEpisode } from "../lib/episodes";
import { createFolder, deleteFolder, refreshStaleSubscriptions, renameFolder } from "../lib/library";
import { buildLibraryTree, episodeLanguage, searchEpisodes, type LibraryNode } from "../lib/organise";
import { formatBytes, formatDate, formatDuration } from "../lib/format";
import { languageLabel } from "../lib/languages";
import { isSaved, savedAudioUrls, storageUsage, useOnline } from "../lib/offline";
import type { Episode, Folder, Subscription } from "../types";

/** Only the states that need attention; a ready episode is the usual case. */
function StatusPill({ ep }: { ep: Episode }) {
  switch (ep.status) {
    case "ready":
      return null;
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
  const store = (next: Set<string>) => {
    const list = [...next];
    setStored(list);
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  };
  const toggle = (id: string) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    store(next);
  };
  const expand = (...ids: string[]) => store(new Set([...open, ...ids]));
  return { open, toggle, expand };
}

/** Where the library was when the learner left it: the topmost row in view, and how far down the screen it was. */
let scrollMemory: { anchor: string; top: number } | undefined;

/**
 * Brings the library back to where it was left, once `ready`: its rows and everything above them
 * are on the page. Returns the function that notes the place, to call before anything that may
 * leave the page.
 */
function useScrollMemory(ready: boolean) {
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || !ready) return;
    restored.current = true;
    const m = scrollMemory;
    const row = m && document.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(m.anchor)}"]`);
    if (row) window.scrollTo(0, row.getBoundingClientRect().top + window.scrollY - m.top);
  });
  return useCallback(() => {
    scrollMemory = undefined;
    if (window.scrollY < 1) return;
    const below = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    for (const row of document.querySelectorAll<HTMLElement>("[data-anchor]")) {
      const top = row.getBoundingClientRect().top;
      if (top >= below) {
        scrollMemory = { anchor: row.dataset.anchor!, top };
        return;
      }
    }
  }, []);
}

export default function Library({ uid }: { uid: string }) {
  const { episodes, error } = useEpisodes(uid);
  const { folders, error: foldersError } = useFolders(uid);
  const { subscriptions, error: subsError } = useSubscriptions(uid);
  const drills = useDrills(uid);
  const drillPrefs = useDrillPrefs(uid);
  const drillSessions = useRecentSessions(uid);
  const online = useOnline();
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [storageTick, setStorageTick] = useState(0);

  useEffect(() => {
    void storageUsage().then(setUsage);
    void savedAudioUrls().then(setSaved, () => undefined);
  }, [episodes?.length, storageTick]);

  // Look for new podcast episodes once per visit; stale feeds only, so quick back-and-forth costs nothing.
  const refreshed = useRef(false);
  useEffect(() => {
    if (!online || !subscriptions?.length || refreshed.current) return;
    refreshed.current = true;
    void refreshStaleSubscriptions(uid, subscriptions);
  }, [online, subscriptions, uid]);

  // Searching is part of the address, so coming back from an episode finds the same results.
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const nav = useNavigate();
  const query = params.get("q");
  const searching = query !== null;
  // The keyboard comes up when the search is opened, not when coming back to its results.
  const [typing, setTyping] = useState(false);
  const openSearch = () => {
    setTyping(true);
    setParams({ q: "" }, { state: { openedSearch: true } });
  };
  const setQuery = (q: string) => {
    setParams({ q }, { replace: true, state: location.state });
    window.scrollTo(0, 0);
  };
  const closeSearch = () => {
    // Opening the search added a step to the history; going back takes it off again.
    if ((location.state as { openedSearch?: boolean } | null)?.openedSearch) nav(-1);
    else setParams({}, { replace: true });
  };

  const tree = useMemo(
    () => (episodes && folders ? buildLibraryTree(episodes, folders) : undefined),
    [episodes, folders],
  );
  const found = useMemo(
    () => (query?.trim() && episodes && folders ? searchEpisodes(episodes, folders, query) : undefined),
    [episodes, folders, query],
  );
  const coverage = useMemo(() => coverageByEpisode(episodes ?? [], drills ?? []), [episodes, drills]);
  const { open, toggle, expand } = useExpanded(tree?.map((n) => n.id) ?? []);
  const subByFeed = useMemo(() => new Map(subscriptions?.map((s) => [s.feedUrl, s.id])), [subscriptions]);
  const folderName = useMemo(() => new Map(folders?.map((f) => [f.id, f.name])), [folders]);
  const remember = useScrollMemory(!!tree && !!drills && !!drillPrefs && !!drillSessions && !!subscriptions);
  const ctx: TreeContext = {
    uid,
    folders: folders ?? [],
    subByFeed,
    coverage,
    savedOffline: (ep) => isSaved(saved, ep.audioUrl),
    open,
    toggle,
    expand,
    onStorageChange: () => setStorageTick((t) => t + 1),
    remember,
  };
  /** Where a search result sits in the library. */
  const placeOf = (ep: Episode) => {
    const lang = episodeLanguage(ep);
    const group = (ep.folderId && folderName.get(ep.folderId)) || ep.feedTitle;
    return [lang === "unknown" ? "" : languageLabel(lang), group].filter(Boolean).join(" · ");
  };

  return (
    <div className="page" onClickCapture={remember}>
      <header className="topbar">
        {searching ? (
          <>
            <input
              className="input search-input"
              type="search"
              autoFocus={typing}
              enterKeyHint="search"
              placeholder="Search titles, podcasts, folders"
              aria-label="Search episodes"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeSearch();
                else if (e.key === "Enter") e.currentTarget.blur(); // puts the phone's keyboard away
              }}
            />
            <button className="btn ghost small" onClick={closeSearch}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <h1>Shadowing</h1>
            {!online && <span className="pill busy">Offline</span>}
            {!!episodes?.length && (
              <button className="btn ghost icon" onClick={openSearch} aria-label="Search episodes" title="Search episodes">
                <SearchIcon />
              </button>
            )}
            {online ? (
              <Link to="/import" className="btn primary small">
                + Import
              </Link>
            ) : (
              <button className="btn primary small" disabled title="Importing needs a connection">
                + Import
              </button>
            )}
          </>
        )}
      </header>

      {(error ?? foldersError ?? subsError) && <p className="error section">{error ?? foldersError ?? subsError}</p>}

      {found ? (
        <SearchResults found={found} query={query ?? ""} placeOf={placeOf} ctx={ctx} />
      ) : (
        <>
          <DrillToday uid={uid} prefs={drillPrefs} drills={drills} sessions={drillSessions} />

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
        </>
      )}

      <footer className="lib-footer">
        {usage && usage.usage > 0 && (
          <span>
            Offline storage used on this device: {formatBytes(usage.usage)}
            {usage.quota ? ` of ${formatBytes(usage.quota)} available` : ""}
          </span>
        )}
        <button className="btn ghost small" onClick={() => void signOut()}>
          Sign out
        </button>
      </footer>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </svg>
  );
}

interface TreeContext {
  uid: string;
  folders: Folder[];
  subByFeed: Map<string, string>;
  coverage: Map<string, Coverage>;
  /** Whether the episode's audio is saved on this device. */
  savedOffline: (ep: Episode) => boolean;
  open: Set<string>;
  toggle: (id: string) => void;
  expand: (...ids: string[]) => void;
  onStorageChange: () => void;
  /** Notes the scroll position (see useScrollMemory). */
  remember: () => void;
}

const ICONS: Record<LibraryNode["kind"], string> = { language: "🌐", folder: "📁", show: "🎙" };

function TreeBranch({ node, depth, ctx }: { node: LibraryNode; depth: number; ctx: TreeContext }) {
  const expanded = ctx.open.has(node.id);
  const [managing, setManaging] = useState(false);
  const subId = node.feedUrl ? ctx.subByFeed.get(node.feedUrl) : undefined;
  const indent = { "--depth": depth } as CSSProperties;
  const folder = node.folder;
  // Folders can be renamed and deleted; languages get new folders.
  const manageable = !!folder || (node.kind === "language" && node.language !== "unknown");

  const newFolder = async () => {
    setManaging(false);
    const name = prompt(`New ${languageLabel(node.language)} folder`)?.trim();
    if (!name) return;
    const id = await createFolder(ctx.uid, name, node.language);
    ctx.expand(node.id, `folder:${id}`);
  };

  return (
    <div className={`branch ${node.kind}`}>
      <div className="tree-row" style={indent} data-anchor={node.id}>
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
        {manageable && (
          <button
            className="btn ghost small"
            aria-label={folder ? `Manage folder ${folder.name}` : `Manage ${node.label}`}
            aria-expanded={managing}
            onClick={() => setManaging((m) => !m)}
          >
            ⋯
          </button>
        )}
      </div>

      {managing && (
        <div className="row tree-actions" style={indent}>
          {folder ? (
            <>
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
            </>
          ) : (
            <button className="btn small" onClick={() => void newFolder()}>
              + New folder
            </button>
          )}
        </div>
      )}

      {expanded && (
        <>
          {node.children.map((c) => (
            <TreeBranch key={c.id} node={c} depth={depth + 1} ctx={ctx} />
          ))}
          {node.episodes.length > 0 && <EpisodeList id={node.id} episodes={node.episodes} depth={depth + 1} ctx={ctx} />}
          {node.kind === "folder" && node.count === 0 && (
            <p className="small muted tree-note" style={{ "--depth": depth + 1 } as CSSProperties}>
              Empty. Move episodes here from their ⋯ menu.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** A group's episodes, a page at a time. */
function EpisodeList({ id, episodes, depth, ctx }: { id: string; episodes: Episode[]; depth: number; ctx: TreeContext }) {
  const paged = usePaged(id, episodes);
  return (
    <div className="ep-list tree-episodes" style={{ "--depth": depth } as CSSProperties}>
      {paged.shown.map((ep) => (
        <EpisodeRow key={ep.id} ep={ep} ctx={ctx} />
      ))}
      <ShowMore paged={paged} />
    </div>
  );
}

function SearchResults({
  found,
  query,
  placeOf,
  ctx,
}: {
  found: Episode[];
  query: string;
  placeOf: (ep: Episode) => string;
  ctx: TreeContext;
}) {
  const paged = usePaged("search", found);
  if (found.length === 0) {
    return (
      <div className="empty">
        <p>No episodes match “{query.trim()}”.</p>
      </div>
    );
  }
  return (
    <div className="ep-list search-results">
      <p className="small muted">
        {found.length} {found.length === 1 ? "episode" : "episodes"}
      </p>
      {paged.shown.map((ep) => (
        <EpisodeRow key={ep.id} ep={ep} place={placeOf(ep)} ctx={ctx} />
      ))}
      <ShowMore paged={paged} />
    </div>
  );
}

/** How much of an episode is in drill excerpts: a pie and a few words. */
function DrillCoverage({ coverage }: { coverage: Coverage }) {
  return (
    <span className="drill-cover">
      <i className="pie" style={{ "--p": `${coverage.full ? 100 : Math.max(4, coverage.fraction * 100)}%` } as CSSProperties} aria-hidden />
      {formatCoverage(coverage)}
    </span>
  );
}

/** One episode in the library: tap to practise, ⋯ to rename, move, save offline or delete. `place` says where it's filed. */
function EpisodeRow({ ep, place, ctx }: { ep: Episode; place?: string; ctx: TreeContext }) {
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const coverage = ctx.coverage.get(ep.id);
  const open = () => !editing && nav(`/episode/${ep.id}`);

  return (
    <div
      className="card ep"
      role="button"
      tabIndex={0}
      data-anchor={`ep:${ep.id}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.target !== e.currentTarget) return;
        ctx.remember();
        open();
      }}
    >
      <div className="body">
        <div className="title">{ep.title}</div>
        <div className="meta">
          <StatusPill ep={ep} />
          {place ? <span>{place}</span> : null}
          {ep.kind === "deck" && ep.cardCount ? (
            <span>Deck · {ep.cardCount} cards</span>
          ) : ep.durationSec ? (
            <span>{formatDuration(ep.durationSec)}</span>
          ) : null}
          <span>{formatDate(ep.createdAt?.toDate())}</span>
          {ctx.savedOffline(ep) && <span title="Saved on this device">✓ Offline</span>}
          {coverage && <DrillCoverage coverage={coverage} />}
        </div>
        {editing && (
          <EpisodeEditor uid={ctx.uid} ep={ep} folders={ctx.folders} onDone={() => setEditing(false)} onStorageChange={ctx.onStorageChange} />
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
          title="Rename, move, save offline or delete"
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
  onStorageChange,
}: {
  uid: string;
  ep: Episode;
  folders: Folder[];
  onDone: () => void;
  onStorageChange: () => void;
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
      {ep.status === "ready" && (
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="small muted">Offline copy</span>
          <span className="spacer" />
          <OfflineButton uid={uid} episode={ep} onChange={onStorageChange} />
        </div>
      )}
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
              void deleteEpisode(uid, ep).then(onStorageChange);
            }
          }}
        >
          Delete
        </button>
      </div>
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
