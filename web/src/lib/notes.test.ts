import { describe, expect, it } from "vitest";
import { highlightSpans, isKnownNote, visibleNotes } from "./notes";
import type { PhraseStudy, StudyNote } from "../types";

const note = (span: string, level: StudyNote["level"] = "B2", kind: StudyNote["kind"] = "vocab"): StudyNote => ({
  kind,
  span,
  title: "",
  body: "",
  level,
});

describe("highlightSpans", () => {
  it("returns the whole text when there are no notes", () => {
    expect(highlightSpans("je sais pas", [])).toEqual([{ text: "je sais pas" }]);
  });
  it("marks each span in order", () => {
    expect(highlightSpans("on a constamment faim.", [note("faim"), note("on a")])).toEqual([
      { text: "on a", note: 1 },
      { text: " constamment " },
      { text: "faim", note: 0 },
      { text: "." },
    ]);
  });
  it("skips spans that overlap an earlier one, preferring the longer at the same start", () => {
    expect(highlightSpans("passer à côté de ma vie", [note("côté"), note("passer à côté de")])).toEqual([
      { text: "passer à côté de", note: 1 },
      { text: " ma vie" },
    ]);
  });
  it("ignores spans that aren't in the text", () => {
    expect(highlightSpans("abc", [note("xyz"), note("")])).toEqual([{ text: "abc" }]);
  });
});

describe("visibleNotes", () => {
  const p = (notes: StudyNote[]): PhraseStudy =>
    ({ key: "k", lang: "fr", text: "", level: "B2", translation: "", literal: "", notes, episodeIds: [] }) as PhraseStudy;
  it("hides notes below the phrase's study level but keeps transcription notes", () => {
    const notes = [note("a", "A2"), note("b", "B2"), note("c", "C1"), note("d", "A2", "transcription")];
    expect(visibleNotes(p(notes)).map((n) => n.span)).toEqual(["b", "c", "d"]);
  });
});

describe("isKnownNote", () => {
  const n = (kind: StudyNote["kind"], span: string, title: string) => ({ kind, span, title });
  const known = [n("grammar", "je sais pas", "Dropped “ne”"), n("vocab", "Truc", "Truc")];
  it("matches the same title whatever the span", () => {
    expect(isKnownNote(n("grammar", "c'est pas", "dropped  “ne”"), known)).toBe(true);
  });
  it("matches the same kind and span, ignoring case", () => {
    expect(isKnownNote(n("vocab", "truc", "Thingy"), known)).toBe(true);
    expect(isKnownNote(n("idiom", "truc", "Thingy"), known)).toBe(false);
  });
  it("never hides transcription notes", () => {
    expect(isKnownNote(n("transcription", "truc", "Truc"), [n("transcription", "truc", "Truc")])).toBe(false);
  });
  it("ignores empty titles and spans", () => {
    expect(isKnownNote(n("vocab", "", ""), [n("vocab", "", "")])).toBe(false);
  });
});
