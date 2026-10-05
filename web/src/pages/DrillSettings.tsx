import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Info } from "../components/Info";
import { PassageMap, PassageMapKey } from "../components/PassageMap";
import { ReviewForecast } from "../components/ReviewForecast";
import { useEpisodes } from "../hooks/useEpisode";
import { useDrillPrefs, useDrills, useNow, useRecentSessions } from "../hooks/useDrills";
import { pickAnchorDay } from "../lib/drill/cadence";
import { DEFAULT_SCHEDULE, FREQUENCIES, SESSION_MINUTES, frequencyOf } from "../lib/drill/labels";
import { formatProgress, progressOf } from "../lib/drill/progress";
import { dayNumber } from "../lib/drill/srs";
import { drillVoice } from "../lib/drill/prepare";
import { drillScheduleKey, logScheduleKey, newScheduleKey, scheduleLabel, scheduleLanguage, schedulesOf } from "../lib/drill/schedules";
import { deleteDrill, setDrillSchedule, setDrillVoice, setSchedule } from "../lib/drill/store";
import { formatBytes, formatTime } from "../lib/format";
import { languageLabel } from "../lib/languages";
import { episodeLanguage } from "../lib/organise";
import { setStudyLevel, subscribeStudyLevels } from "../lib/study";
import { ENGLISH_VOICES, isVoiceStored, loadVoice } from "../lib/tts/client";
import { clearClips, storedClipBytes } from "../lib/tts/clipCache";
import { CEFR_LEVELS, type CefrLevel, type Drill, type DrillPrefs, type DrillSchedule, type DrillSessionLog } from "../types";

/** The schedule with an anchor day that takes turns with other languages on the same rhythm. */
function withTurn(schedule: DrillSchedule, others: DrillSchedule[]): DrillSchedule {
  const next = { ...schedule };
  if (next.everyDays > 1) next.anchorDay = pickAnchorDay(others, next.everyDays, dayNumber(Date.now()));
  else delete next.anchorDay;
  return next;
}

export default function DrillSettings({ uid }: { uid: string }) {
  const { episodes } = useEpisodes(uid);
  const prefs = useDrillPrefs(uid);
  const drills = useDrills(uid);
  const sessions = useRecentSessions(uid);
  const [levels, setLevels] = useState<Record<string, CefrLevel>>({});
  useEffect(() => subscribeStudyLevels(uid, setLevels), [uid]);

  const languages = useMemo(() => {
    const set = new Set<string>();
    for (const ep of episodes ?? []) {
      const l = episodeLanguage(ep);
      if (l !== "unknown" && l !== "auto") set.add(l);
    }
    for (const [k, s] of Object.entries(prefs?.schedules ?? {})) set.add(scheduleLanguage(k, s));
    for (const d of drills ?? []) set.add(d.language);
    return [...set].sort((a, b) => languageLabel(a).localeCompare(languageLabel(b)));
  }, [episodes, prefs, drills]);

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="btn ghost icon" aria-label="Back">
          ‹
        </Link>
        <h1>
          Drill schedules
          <Info>
            Each language you drill gets its own rhythm, and can have more than one schedule, say one per podcast or deck. A
            session reviews what's due first, then learns new passages of your current excerpt with the time left. Choose
            excerpts from an episode's <b>Drill</b> button.
          </Info>
        </h1>
      </header>
      {!!drills?.length && (
        <div className="section" style={{ paddingBottom: 0 }}>
          <PassageMapKey />
        </div>
      )}
      {prefs === undefined || drills === undefined ? (
        <div className="center">
          <div className="spinner" />
        </div>
      ) : (
        <div className="list">
          {languages.length === 0 && <p className="muted small">Import an episode first.</p>}
          {languages.map((lang) => (
            <LanguageCard
              key={lang}
              uid={uid}
              language={lang}
              prefs={prefs}
              level={levels[lang]}
              drills={drills.filter((d) => d.language === lang)}
              sessions={(sessions ?? []).filter((s) => s.language === lang && s.progress > 0)}
            />
          ))}
        </div>
      )}
      <div className="section">
        <EnglishVoice uid={uid} voice={drillVoice(prefs)} />
      </div>
    </div>
  );
}

/** A language's schedules: its main one, keyed by the language, and any others added for it. */
function LanguageCard(props: {
  uid: string;
  language: string;
  prefs: DrillPrefs;
  level?: CefrLevel;
  drills: Drill[];
  /** The language's recent sessions that count towards its schedules. */
  sessions: DrillSessionLog[];
}) {
  const { uid, language, prefs } = props;
  const now = useNow();
  const [error, setError] = useState<string>();
  const keys = schedulesOf(prefs, language);
  const extras = keys.filter((k) => k !== language);
  const main = prefs.schedules[language];
  /** Every other schedule, to take turns with. */
  const others = (key: string) =>
    Object.entries(prefs.schedules)
      .filter(([k]) => k !== key)
      .map(([, s]) => s);
  const save = (key: string, next: DrillSchedule | null) => void setSchedule(uid, key, next).catch((e) => setError(String(e)));
  const on = (key: string) => ({
    drills: props.drills.filter((d) => drillScheduleKey(d, prefs) === key),
    sessions: props.sessions.filter((s) => logScheduleKey(s, prefs) === key),
  });

  const addSchedule = () => {
    const name = prompt(`What's the new ${languageLabel(language)} schedule for? (a podcast or deck, say)`)?.trim();
    if (!name) return;
    const key = newScheduleKey(language);
    save(key, withTurn({ ...DEFAULT_SCHEDULE, language, name }, others(key)));
  };

  return (
    <div className="card lang-card">
      <div className="body">
        <div className="row">
          <span className="title">{languageLabel(language)}</span>
          <span className="spacer" />
          <label className="row small">
            <input
              type="checkbox"
              checked={!!main}
              onChange={(e) => {
                if (e.target.checked) save(language, withTurn(DEFAULT_SCHEDULE, others(language)));
                else if (confirm(`Stop scheduling ${scheduleLabel(language, main)} drills? Your excerpts and progress are kept.`))
                  save(language, null);
              }}
            />
            Drill
          </label>
        </div>
        {keys.length > 0 && (
          <label className="field-row">
            <span>Your level</span>
            <select className="input" value={props.level ?? ""} onChange={(e) => void setStudyLevel(uid, language, e.target.value as CefrLevel)}>
              {!props.level && <option value="">Not set</option>}
              {CEFR_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
        {main && extras.length > 0 && <ScheduleName key={main.name} schedule={main} placeholder="Main schedule" onSave={(name) => save(language, { ...main, name })} />}
        {main && <ScheduleFields schedule={main} others={others(language)} save={(next) => save(language, next)} />}
        {main && <ReviewForecast schedule={main} drills={on(language).drills} sessions={on(language).sessions} now={now} />}
        <Excerpts uid={uid} prefs={prefs} keys={keys} drills={on(language).drills} />
        {extras.map((key) => {
          const schedule = prefs.schedules[key];
          return (
            <div key={key} className="schedule-block">
              <div className="row">
                <ScheduleName key={schedule.name} schedule={schedule} placeholder="Name" onSave={(name) => save(key, { ...schedule, name })} />
                <button
                  className="btn ghost small danger"
                  onClick={() => {
                    const where = main ? `move to the main ${languageLabel(language)} schedule` : "are kept, unscheduled";
                    if (confirm(`Remove the ${scheduleLabel(key, schedule)} schedule? Its excerpts and their progress ${where}.`)) save(key, null);
                  }}
                >
                  Remove
                </button>
              </div>
              <ScheduleFields schedule={schedule} others={others(key)} save={(next) => save(key, next)} />
              <ReviewForecast schedule={schedule} drills={on(key).drills} sessions={on(key).sessions} now={now} />
              <Excerpts uid={uid} prefs={prefs} keys={keys} drills={on(key).drills} />
            </div>
          );
        })}
        {keys.length > 0 && (
          <button className="btn ghost small" style={{ alignSelf: "flex-start" }} onClick={addSchedule}>
            + Another {languageLabel(language)} schedule
          </button>
        )}
        {error && <p className="small error">{error}</p>}
      </div>
    </div>
  );
}

/** A schedule's name, saved when the field is left. Keyed by the saved name, so it shows changes made elsewhere. */
function ScheduleName({ schedule, placeholder, onSave }: { schedule: DrillSchedule; placeholder: string; onSave: (name: string) => void }) {
  const [name, setName] = useState(schedule.name ?? "");
  return (
    <input
      className="input schedule-name"
      value={name}
      placeholder={placeholder}
      aria-label="Schedule name"
      onChange={(e) => setName(e.target.value)}
      onBlur={() => name.trim() !== (schedule.name ?? "") && onSave(name.trim())}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

function ScheduleFields({ schedule, others, save }: { schedule: DrillSchedule; others: DrillSchedule[]; save: (next: DrillSchedule) => void }) {
  const set = (patch: Partial<DrillSchedule>) => save({ ...schedule, ...patch });
  return (
    <div className="lang-fields">
      <label className="field-row">
        <span>How often</span>
        <select
          className="input"
          value={frequencyOf(schedule).id}
          onChange={(e) => {
            const f = FREQUENCIES.find((x) => x.id === e.target.value)!;
            save(withTurn({ ...schedule, perDay: f.perDay, everyDays: f.everyDays }, others));
          }}
        >
          {FREQUENCIES.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field-row">
        <span>Each session</span>
        <select className="input" value={schedule.minutes} onChange={(e) => set({ minutes: Number(e.target.value) })}>
          {(SESSION_MINUTES.includes(schedule.minutes) ? SESSION_MINUTES : [...SESSION_MINUTES, schedule.minutes].sort((a, b) => a - b)).map((m) => (
            <option key={m} value={m}>
              {m} minutes
            </option>
          ))}
        </select>
      </label>
      <label className="field-row">
        <span>Learning drill</span>
        <select className="input" value={schedule.learning} onChange={(e) => set({ learning: e.target.value as DrillSchedule["learning"] })}>
          <option value="full">Full: 3 plays, slowed</option>
          <option value="light">Light: 2 plays</option>
        </select>
      </label>
      <label className="field-row">
        <span>Time to answer</span>
        <select className="input" value={schedule.answerTime ?? 0} onChange={(e) => set({ answerTime: Number(e.target.value) || undefined })}>
          <option value={0}>Normal</option>
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? "second" : "seconds"} more
            </option>
          ))}
        </select>
      </label>
      <label className="row small">
        <input type="checkbox" checked={schedule.newMaterial} onChange={(e) => set({ newMaterial: e.target.checked })} />
        Learn new passages once the reviews are done
      </label>
    </div>
  );
}

/** A schedule's excerpts, oldest first. */
function Excerpts({ uid, prefs, keys, drills }: { uid: string; prefs: DrillPrefs; keys: string[]; drills: Drill[] }) {
  if (drills.length === 0) return null;
  return (
    <div className="excerpts">
      {[...drills]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((d) => (
          <ExcerptRow key={d.id} uid={uid} drill={d} prefs={prefs} keys={keys} />
        ))}
    </div>
  );
}

/** One excerpt or deck, with a choice of schedule when its language has more than one. */
function ExcerptRow({ uid, drill, prefs, keys }: { uid: string; drill: Drill; prefs: DrillPrefs; keys: string[] }) {
  const now = useNow();
  return (
    <div className="excerpt-row">
      <div className="body">
        <Link to={`/episode/${drill.episodeId}`}>{drill.title ?? drill.episodeTitle}</Link>
        <div className="small muted">
          {drill.kind === "cards" ? (
            `Deck · ${drill.passages.length} cards`
          ) : (
            <>
              {drill.title ? `${drill.episodeTitle} · ` : ""}
              {formatTime(drill.start)}–{formatTime(drill.end)}
            </>
          )}
        </div>
        <PassageMap drill={drill} now={now} />
        <div className="small muted">{formatProgress(progressOf([drill], now))}</div>
        {keys.length > 1 && (
          <select
            className="input excerpt-schedule"
            aria-label="Schedule"
            value={drillScheduleKey(drill, prefs)}
            onChange={(e) => void setDrillSchedule(uid, drill, e.target.value)}
          >
            {keys.map((k) => (
              <option key={k} value={k}>
                On {prefs.schedules[k].name ?? (k === drill.language ? "the main schedule" : "an unnamed schedule")}
              </option>
            ))}
          </select>
        )}
      </div>
      <button
        className="btn ghost small danger"
        onClick={() => {
          const what = drill.kind === "cards" ? `the deck "${drill.episodeTitle}"` : `this excerpt of "${drill.episodeTitle}"`;
          if (confirm(`Stop drilling ${what}? Its progress is deleted.`)) void deleteDrill(uid, drill.id);
        }}
      >
        Remove
      </button>
    </div>
  );
}

/** The on-device voice that reads the English cues (shared with the practice player's English audio). */
/** The on-device voice that reads drills' English cues, and the clips it has made. */
function EnglishVoice({ uid, voice }: { uid: string; voice: string }) {
  const [stored, setStored] = useState<boolean>();
  const [download, setDownload] = useState<{ loaded: number; total: number }>();
  const [clipBytes, setClipBytes] = useState(() => storedClipBytes());
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void isVoiceStored(voice).then((ok) => !cancelled && setStored(ok));
    return () => {
      cancelled = true;
    };
  }, [voice]);

  const fetchVoice = async () => {
    setError(undefined);
    setDownload({ loaded: 0, total: 0 });
    try {
      await loadVoice(voice, (loaded, total) => setDownload({ loaded, total }));
      setStored(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownload(undefined);
    }
  };

  return (
    <div>
      <label className="field-row">
        <span>
          English voice
          <Info>
            Reads the English cues on this device, so drills work offline once it's downloaded. The clips it makes are kept,
            and made ahead while the library is open, so sessions can start at once.
          </Info>
        </span>
        <select className="input" value={voice} onChange={(e) => void setDrillVoice(uid, e.target.value).catch((err) => setError(String(err)))}>
          {ENGLISH_VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </label>
      {stored === false && (
        <button className="btn small" style={{ marginTop: 8 }} disabled={!!download} onClick={() => void fetchVoice()}>
          {download
            ? download.total
              ? `Downloading ${Math.round((download.loaded / download.total) * 100)}%…`
              : "Downloading…"
            : "Download voice (about 60 MB)"}
        </button>
      )}
      <div className="row small" style={{ marginTop: 8, justifyContent: "space-between" }}>
        <span className="muted">English clips on this device: {formatBytes(clipBytes)}</span>
        <button
          className="btn ghost small"
          disabled={clipBytes === 0}
          onClick={() => void clearClips().then(() => setClipBytes(storedClipBytes()))}
        >
          Clear
        </button>
      </div>
      {error && <p className="small error">{error}</p>}
    </div>
  );
}
