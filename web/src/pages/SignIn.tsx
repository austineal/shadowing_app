import { useState } from "react";
import { signIn } from "../hooks/useAuth";

export default function SignIn() {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <div className="center" style={{ height: "100dvh" }}>
      <img src="/icon-192.png" alt="" width={72} height={72} style={{ borderRadius: 18 }} />
      <h1>Shadowing</h1>
      <p className="muted">Phrase-by-phrase listening and repeating practice.</p>
      <button
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            await signIn();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Sign in with Google
      </button>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
