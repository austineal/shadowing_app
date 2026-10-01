import { useEffect, useState } from "react";
import { useDrillPrefs, useExcerptSuggestions, useNow, useRecentSessions } from "../hooks/useDrills";
import { DEFAULT_SCHEDULE, formatMinutes } from "../lib/drill/labels";
import { excerptMinutes, formatLearningTime, weeklyPace } from "../lib/drill/pace";
import { logScheduleKey, scheduleForEpisode } from "../lib/drill/schedules";
import { phraseSpan } from "../lib/drill/passages";
import { drillOptions } from "../lib/drill/steps";
import { suggestExcerpts } from "../lib/drill/store";
import { formatTime } from "../lib/format";
import { languageLabel } from "../lib/languages";
import { loadDefaultSettings } from "../lib/settings";
import { setStudyLevel, subscribeStudyLevels } from "../lib/study";
import { CEFR_LEVELS, type CefrLevel, type Drill, type Episode, type ExcerptSection, type Segment } from "../types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How a section's level compares with the learner's. */
function levelNote(section: CefrLevel, learner: CefrLevel | undefined): string {
  if (!learner) return "";
  const diff = CEFR_LEVELS.indexOf(section) - CEFR_LEVELS.indexOf(learner);
  if (diff < 0) return "easier than your level";
  if (diff === 0) return "your level";
  return diff === 1 ? "a stretch" : "well above your level";
}

const SPEAKING_LABEL: Record<ExcerptSection["speaking"], string> = {
  good: "good for speaking",
  fair: "fair",
  skip: "skip",
};

/**
 * Claude's suggestions for excerpts to drill: the episode split into self-contained sections about
 * two weeks' worth of new material long, rated for speaking practice. Choosing one hands its
 * phrases to the excerpt picker.
 */
export function ExcerptSuggestionsSheet(props: {
  uid: string;
  episode: Episode;
  language: string;
  segments: Segment[];
  /** Excerpts of this episode already being drilled. */
  existing: Drill[];
  onChoose: (pick: { first: number; last: number; title: string }) => void;
  onClose: () => void;
}) {
  const { uid, episode, language } = props;
  const suggestions = useExcerptSuggestions(uid, episode.id);
  const prefs = useDrillPrefs(uid);
  const sessions = useRecentSessions(uid);
  const now = useNow();
  const [levels, setLevels] = useState<Record<string, CefrLevel>>({});
  useEffect(() => subscribeStudyLevels(uid, setLevels), [uid]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Sized for the schedule this episode's excerpts are drilled on.
  const key = scheduleForEpisode(prefs, language, props.existing);
  const schedule = prefs?.schedules[key] ?? DEFAULT_SCHEDULE;
  const pace = weeklyPace(
    schedule,
    (sessions ?? []).filter((l) => logScheduleKey(l, prefs) === key),
    drillOptions(schedule.learning, loadDefaultSettings(), schedule.answerTime ?? 0),
    now,
  );
  const minutes = excerptMinutes(pace);
  const level = levels[language];
  const sections = suggestions?.sections ?? [];

  const overlaps = (s: ExcerptSection) => props.existing.some((d) => d.start < s.end && s.start < d.end);
  // After the latest excerpt of this episode, the next worthwhile section carries the story on.
  const latestEnd = props.existing.length ? Math.max(...props.existing.map((d) => d.end)) : undefined;
  const next =
    latestEnd === undefined ? -1 : sections.findIndex((s) => s.speaking !== "skip" && s.start >= latestEnd - 1 && !overlaps(s));

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await suggestExcerpts({ episodeId: episode.id, language, minutes });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = (s: ExcerptSection) => {
    const span = phraseSpan(props.segments, s.start, s.end);
    if (span) props.onChoose({ ...span, title: s.title });
  };

  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div className="sheet suggestions-sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Suggested excerpts</h2>
        <p className="small muted">
          Claude splits the episode into self-contained sections of about {minutes} minutes: roughly two weeks of new material at
          your {languageLabel(language)} pace{pace.measured ? "" : " (estimated from your schedule until you've drilled for two weeks)"}
          .
        </p>

        {!level && (
          <label className="row small" style={{ marginTop: 10 }}>
            Your level in {languageLabel(language)}:
            <select
              className="input"
              style={{ width: "auto", padding: "4px 8px", minHeight: 32 }}
              value=""
              onChange={(e) => void setStudyLevel(uid, language, e.target.value as CefrLevel)}
            >
              <option value="">Not set</option>
              {CEFR_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}

        {suggestions === undefined ? (
          <div className="center">
            <div className="spinner" />
          </div>
        ) : sections.length === 0 ? (
          <div style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy || !level} onClick={() => void run()}>
              {busy ? "Reading the transcript…" : "Suggest excerpts"}
            </button>
            <p className="small muted" style={{ marginTop: 8 }}>
              Claude reads the whole transcript, which takes a minute or two for a long episode. You can close this and come back;
              the suggestions are saved with the episode.
            </p>
          </div>
        ) : (
          <>
            <div className="suggestions">
              {sections.map((s, i) => {
                const drilling = overlaps(s);
                const note = levelNote(s.level, level);
                return (
                  <div key={i} className={`suggestion ${s.speaking} ${i === next ? "next" : ""}`}>
                    <div className="suggestion-head">
                      <span className="title">{s.title}</span>
                      {i === next && <span className="pill ready">Next</span>}
                      {drilling ? <span className="pill busy">Drilling</span> : <span className="pill">{SPEAKING_LABEL[s.speaking]}</span>}
                    </div>
                    <div className="small muted">
                      {formatTime(s.start)}–{formatTime(s.end)} · {formatMinutes(s.end - s.start)} · {s.level}
                      {note ? ` (${note})` : ""}
                      {s.speaking !== "skip" ? ` · ${formatLearningTime(s.end - s.start, pace)} to learn` : ""}
                    </div>
                    <p className="small">{s.summary}</p>
                    <p className="small muted">{s.why}</p>
                    {s.speaking !== "skip" && !drilling && (
                      <button className="btn small" onClick={() => choose(s)}>
                        Choose
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn small" disabled={busy || !level} onClick={() => void run()}>
                {busy ? "Reading the transcript…" : "Suggest again"}
              </button>
              <span className="small muted">
                Made for {suggestions?.level}, about {suggestions?.minutes} min each
              </span>
            </div>
          </>
        )}
        {error && <p className="small error">{error}</p>}
        <button className="btn" style={{ marginTop: 14, width: "100%" }} onClick={props.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

