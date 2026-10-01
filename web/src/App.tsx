import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import SignIn from "./pages/SignIn";
import Library from "./pages/Library";
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
        <Route path="/" element={<Library uid={uid} />} />
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
