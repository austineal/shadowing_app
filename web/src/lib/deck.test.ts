import { describe, expect, it } from "vitest";
import { cardPassages, fileRef, guessColumns, hasHeader, parseCsv, readCards } from "./deck";
import type { Segment } from "../types";

describe("parseCsv", () => {
  it("reads quoted fields, doubled quotes, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });
  it("detects tabs", () => {
    expect(parseCsv("a\tb,c\n1\t2")).toEqual([
      ["a", "b,c"],
      ["1", "2"],
    ]);
  });
});

describe("columns", () => {
  const files = new Set(["001.mp3", "001_en.mp3", "002.mp3", "002_en.mp3"]);
  const rows = parseCsv(
    [
      "Sentence,English,Audio,English audio,Level",
      "今日は雨です。,It's raining today.,001.mp3,001_en.mp3,Level 1",
      "駅はどこですか。,Where is the station?,[sound:002.mp3],002_en.mp3,Level 2",
    ].join("\n"),
  );

  it("guesses each column, ignoring others", () => {
    expect(fileRef("[sound:Foo.MP3]")).toBe("foo.mp3");
    expect(hasHeader(rows, files)).toBe(true);
    expect(guessColumns(rows[0], rows.slice(1), files)).toEqual({ text: 0, english: 1, audio: 2, englishAudio: 3 });
  });

  it("guesses without a header, by content", () => {
    const body = rows.slice(1).map((r) => [r[2], r[3], r[1], r[0]]);
    expect(hasHeader(body, files)).toBe(false);
    expect(guessColumns(null, body, files)).toEqual({ audio: 0, englishAudio: 1, english: 2, text: 3 });
  });

  it("matches rows to files and says which it skips", () => {
    const f = (name: string) => new File(["x"], name, { type: "audio/mpeg" });
    const read = readCards(rows.slice(1).concat([["何？", "What?", "003.mp3", "", ""]]), { text: 0, english: 1, audio: 2, englishAudio: 3 }, [f("001.mp3"), f("001_EN.mp3"), f("002.mp3"), f("002_en.mp3")], 1);
    expect(read.cards.map((c) => [c.text, c.audio.name, c.englishAudio?.name])).toEqual([
      ["今日は雨です。", "001.mp3", "001_EN.mp3"],
      ["駅はどこですか。", "002.mp3", "002_en.mp3"],
    ]);
    expect(read.skipped).toEqual([{ row: 4, why: "no file called 003.mp3" }]);
  });
});

describe("cardPassages", () => {
  const seg = (i: number): Segment => ({ id: `c${i}`, start: i * 10, end: i * 10 + 3, text: `${i}` });

  it("shuffles every card into the order to learn them in", () => {
    const passages = cardPassages([seg(0), seg(1), seg(2), seg(3)], () => 0);
    expect(passages.map((p) => p.start)).toEqual([10, 20, 30, 0]);
    expect(passages.every((p) => p.card && p.end === p.start + 3)).toBe(true);
  });
});
