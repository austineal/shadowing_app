import { CEFR_LEVELS, type PhraseStudy, type StudyNote } from "../types";

/**
 * Notes worth showing: those at or above the level the phrase was studied for. The server now
 * filters these itself, but phrases generated before that still carry easier notes. Transcription
 * notes are about the text, not the learner's French, so they always show.
 */
export function visibleNotes(p: PhraseStudy): StudyNote[] {
  const min = CEFR_LEVELS.indexOf(p.level);
  return p.notes.filter((n) => n.kind === "transcription" || CEFR_LEVELS.indexOf(n.level) >= min);
}

export interface TextPart {
  text: string;
  /** Index into the notes array for a highlighted span. */
  note?: number;
}

/**
 * Splits `text` into plain and highlighted parts, one highlight per note at the span's first
 * occurrence. Spans that overlap an earlier-starting one are left unhighlighted.
 */
export function highlightSpans(text: string, notes: Pick<StudyNote, "span">[]): TextPart[] {
  const hits = notes
    .map((n, note) => ({ note, start: n.span ? text.indexOf(n.span) : -1, len: n.span.length }))
    .filter((h) => h.start >= 0)
    .sort((a, b) => a.start - b.start || b.len - a.len);
  const parts: TextPart[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.start < pos) continue;
    if (h.start > pos) parts.push({ text: text.slice(pos, h.start) });
    parts.push({ text: text.slice(h.start, h.start + h.len), note: h.note });
    pos = h.start + h.len;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos) });
  return parts;
}
