import { Link } from "react-router-dom";
import { DrillToday } from "../components/DrillToday";
import { useDrillPrefs, useDrills, useRecentSessions } from "../hooks/useDrills";

export default function Drills({ uid }: { uid: string }) {
  const prefs = useDrillPrefs(uid);
  const drills = useDrills(uid);
  const sessions = useRecentSessions(uid);
  return (
    <div className="page">
      <header className="topbar">
        <h1>Drill</h1>
        {!!prefs && Object.keys(prefs.schedules).length > 0 && (
          <Link to="/drill/settings" className="btn ghost small">
            Schedules
          </Link>
        )}
      </header>
      <DrillToday uid={uid} prefs={prefs} drills={drills} sessions={sessions} />
    </div>
  );
}
