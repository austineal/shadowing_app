import { describe, expect, it } from "vitest";
import { phraseKey } from "./study";

describe("phraseKey", () => {
  it("matches the Cloud Functions key", async () => {
    // Expected values from phraseKey in functions/src/study.ts (Node crypto).
    for (const [lang, text, key] of [
      ["fr", "tellement c'est une époque d'une richesse incomparable.", "239deb3f3f4e99694aad90b5e47de59d"],
      ["cy", "Mae'n braf heddiw.", "4afd2d7414e54cd7be80d0f0f5d30f55"],
      ["ja", "今日はいい天気ですね。", "e16d581817ace273d0d421502ccc841b"],
    ]) {
      expect(await phraseKey(lang, text)).toBe(key);
    }
  });
  it("ignores whitespace differences and Unicode composition", async () => {
    const composed = "époque";
    const decomposed = "époque";
    expect(await phraseKey("fr", `  une ${composed}\n`)).toBe(await phraseKey("fr", `une  ${decomposed}`));
  });
  it("differs by language", async () => {
    expect(await phraseKey("fr", "a")).not.toBe(await phraseKey("es", "a"));
  });
});
