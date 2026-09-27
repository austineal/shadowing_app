import { useEffect, useRef, useState } from "react";
import { highlightSpans, visibleNotes } from "../lib/notes";
import { clearThread, explainPhrase, type ExplainMode } from "../lib/study";
import type { PhraseStudy } from "../types";

const KIND_LABEL: Record<string, string> = {
  grammar: "Grammar",
  idiom: "Idiom",
  vocab: "Vocabulary",
  culture: "Culture",
  pronunciation: "Spoken form",
  transcription: "Transcript",
};

/** Translation, notes and follow-up questions for one phrase. */
export function PhraseStudySheet(props: { uid: string; episodeId: string; phrase: PhraseStudy; onClose: () => void }) {
  const { uid, episodeId, phrase } = props;
  const notes = visibleNotes(phrase);
  /** Index of each visible note in phrase.notes, which is what the server refers to. */
  const noteIndex = notes.map((n) => phrase.notes.indexOf(n));
  const parts = highlightSpans(phrase.text, notes);

  const [showLiteral, setShowLiteral] = useState(false);
  const [focused, setFocused] = useState<number>();
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const threadEnd = useRef<HTMLDivElement>(null);
  const thread = phrase.thread ?? [];

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [thread.length, pending]);

  const ask = async (mode: ExplainMode, label: string, note?: number, q?: string) => {
    setPending(label);
    setError(undefined);
    try {
      await explainPhrase({ key: phrase.key, episodeId, mode, note, question: q });
      if (mode === "question") setQuestion("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(undefined);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div className="sheet study-sheet" onClick={(e) => e.stopPropagation()}>
        <p className="study-phrase">
          {parts.map((part, i) =>
            part.note === undefined ? (
              <span key={i}>{part.text}</span>
            ) : (
              <mark
                key={i}
                className={focused === part.note ? "focused" : ""}
                onClick={() => {
                  setFocused(part.note);
                  document.getElementById(`note-${part.note}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
                }}
              >
                {part.text}
              </mark>
            ),
          )}
        </p>
        <p className="study-translation">{phrase.translation}</p>
        {phrase.literal && (
          <button className="btn small ghost" style={{ padding: 0 }} onClick={() => setShowLiteral((v) => !v)}>
            {showLiteral ? `Word for word: ${phrase.literal}` : "Show word for word"}
          </button>
        )}

        {notes.length > 0 ? (
          <div className="notes">
            {notes.map((n, i) => (
              <div key={i} id={`note-${i}`} className={`note ${focused === i ? "focused" : ""}`} onClick={() => setFocused(i)}>
                <div className="note-head">
                  <b>{n.title}</b>
                  <span className="pill">
                    {KIND_LABEL[n.kind] ?? n.kind} · {n.level}
                  </span>
                </div>
                <p className="small">
                  <mark>{n.span}</mark> {n.body}
                </p>
                <div className="row" style={{ marginTop: 6 }}>
                  <button
                    className="btn small"
                    disabled={!!pending}
                    onClick={() => void ask("detail", `More detail: ${n.span}`, noteIndex[i])}
                  >
                    More detail
                  </button>
                  <button
                    className="btn small"
                    disabled={!!pending}
                    onClick={() => void ask("different", `Explain differently: ${n.span}`, noteIndex[i])}
                  >
                    Explain differently
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="row" style={{ marginTop: 12 }}>
            <span className="small muted">Nothing here above your level.</span>
            <span className="spacer" />
            <button className="btn small" disabled={!!pending} onClick={() => void ask("detail", "Explain this phrase")}>
              Explain it anyway
            </button>
          </div>
        )}

        {(thread.length > 0 || pending) && (
          <div className="thread">
            {thread.map((t, i) => (
              <div key={i} className={`bubble ${t.role}`}>
                {t.text}
              </div>
            ))}
            {pending && (
              <>
                <div className="bubble user">{pending}</div>
                <div className="bubble assistant">
                  <div className="spinner" />
                </div>
              </>
            )}
            {thread.length > 0 && !pending && (
              <button className="btn small ghost" style={{ alignSelf: "flex-end" }} onClick={() => void clearThread(uid, phrase.key)}>
                Clear conversation
              </button>
            )}
            <div ref={threadEnd} />
          </div>
        )}
        {error && <p className="small error">{error}</p>}

        <form
          className="row"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            const q = question.trim();
            if (q && !pending) void ask("question", q, undefined, q);
          }}
        >
          <input
            className="input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about this phrase…"
            disabled={!!pending}
          />
          <button className="btn small primary" disabled={!question.trim() || !!pending}>
            Ask
          </button>
        </form>

        <button className="btn" style={{ marginTop: 14, width: "100%" }} onClick={props.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
