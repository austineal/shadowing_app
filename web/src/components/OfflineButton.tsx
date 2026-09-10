import { useEffect, useState, type MouseEvent } from "react";
import { cacheEpisodeForOffline, ensureAudioUrl, removeEpisodeOfflineData } from "../lib/episodes";
import { cacheSupported, isAudioCached, useOnline } from "../lib/offline";
import type { Episode } from "../types";

type State = "checking" | "no" | "yes" | "busy" | "unsupported";

/** Save / remove an episode's audio and word timings for offline use. */
export function OfflineButton({
  uid,
  episode,
  onChange,
}: {
  uid: string;
  episode: Episode;
  onChange?: () => void;
}) {
  const [state, setState] = useState<State>("checking");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string>();
  const online = useOnline();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cacheSupported()) {
        setState("unsupported");
        return;
      }
      const yes = await isAudioCached(episode.audioUrl);
      if (!cancelled) setState(yes ? "yes" : "no");
    })();
    return () => {
      cancelled = true;
    };
  }, [episode.audioUrl]);

  const save = async (e: MouseEvent) => {
    e.stopPropagation();
    setState("busy");
    setProgress(0);
    setError(undefined);
    try {
      const url = await ensureAudioUrl(uid, episode);
      await cacheEpisodeForOffline(uid, episode, url, (loaded, total) => setProgress(total ? loaded / total : 0));
      setState("yes");
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("no");
    }
  };

  const remove = async (e: MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Remove the offline copy of "${episode.title}"?`)) return;
    await removeEpisodeOfflineData(uid, episode);
    setState("no");
    onChange?.();
  };

  if (state === "unsupported" || episode.status !== "ready") return null;
  if (state === "checking") return <span className="pill">…</span>;
  if (state === "busy") {
    return (
      <span className="pill busy" aria-live="polite">
        {progress > 0 ? `${Math.round(progress * 100)}%` : "Saving…"}
      </span>
    );
  }
  if (state === "yes") {
    return (
      <button className="btn small" onClick={remove} title="Saved for offline use. Tap to remove.">
        ✓ Offline
      </button>
    );
  }
  return (
    <span className="row" style={{ gap: 6 }}>
      <button
        className="btn small"
        onClick={save}
        disabled={!online}
        title={online ? "Download for offline use" : "Connect to the internet to download"}
      >
        ⬇ Save offline
      </button>
      {error && <span className="error small">{error}</span>}
    </span>
  );
}
