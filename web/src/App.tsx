import { Navigate, NavLink, Outlet, Route, Routes } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { useDrillPrefs, useDrills, useNow, useRecentSessions } from "./hooks/useDrills";
import { dueSessions } from "./components/DrillToday";
import SignIn from "./pages/SignIn";
import Library from "./pages/Library";
import Drills from "./pages/Drills";
import Import from "./pages/Import";
import Practice from "./pages/Practice";
import Podcast from "./pages/Podcast";
import DrillSession from "./pages/DrillSession";
import DrillSettings from "./pages/DrillSettings";

export default function App() {
  const user = useAuth();
  if (user === undefined) {
    return (
      <div className="center" style={{ height: "100dvh" }}>
        <div className="spinner" />
      </div>
    );
  }
  if (!user) return <SignIn />;
  const uid = user.uid;
  return (
    <div className="app">
      <Routes>
        <Route element={<Tabs uid={uid} />}>
          <Route path="/" element={<Library uid={uid} />} />
          <Route path="/drills" element={<Drills uid={uid} />} />
        </Route>
        <Route path="/import" element={<Import uid={uid} />} />
        <Route path="/episode/:id" element={<Practice uid={uid} />} />
        <Route path="/podcast/:id" element={<Podcast uid={uid} />} />
        <Route path="/drill/settings" element={<DrillSettings uid={uid} />} />
        <Route path="/drill/:schedule" element={<DrillSession uid={uid} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

/** The two halves of the app: listening to episodes, and drilling what was picked from them. */
function Tabs({ uid }: { uid: string }) {
  const prefs = useDrillPrefs(uid);
  const drills = useDrills(uid);
  const sessions = useRecentSessions(uid);
  const now = useNow();
  const due = prefs && drills && sessions ? dueSessions(prefs, drills, sessions, now) : 0;
  return (
    <>
      <Outlet />
      <nav className="tabbar">
        <NavLink to="/" end>
          Listen
        </NavLink>
        <NavLink to="/drills">
          Drill
          {due > 0 && <span className="badge" aria-label={`${due} due`}>{due}</span>}
        </NavLink>
      </nav>
    </>
  );
}
