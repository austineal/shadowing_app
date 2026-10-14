import { expect, it } from "vitest";
import { LANGUAGES, isCharBased, languageLabel, normalizeLanguageCode } from "./languages";

it("stores the codes older episodes already use", () => {
  expect(["fra", "cym", "nob", "nor", "nno", "cmn", "zho", "eng", "fr-FR"].map(normalizeLanguageCode)).toEqual([
    "fr", "cy", "no", "no", "no", "zh", "zh", "en", "fr",
  ]);
  for (const c of ["fr", "cy", "ja", "no", "de", "zh", "pl", "yue", "fil"]) {
    expect(LANGUAGES.some((l) => l.code === c)).toBe(true);
  }
  expect(LANGUAGES.some((l) => l.code === "nn")).toBe(false);
  expect(languageLabel("nn")).toBe("Norwegian");
  expect(languageLabel("pol")).toBe("Polish");
  expect(["ff", "luo", "umb"].map(languageLabel)).toEqual(["Fulah", "Luo", "Umbundu"]);
  expect(LANGUAGES).toHaveLength(101);
  expect(isCharBased("jpn") && isCharBased("yue") && !isCharBased("fr")).toBe(true);
});
