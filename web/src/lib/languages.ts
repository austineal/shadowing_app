/**
 * Languages offered in the import UI. `code` is what we send to ElevenLabs as
 * language_code (ISO-639-1/-3). `charBased` languages have no spaces between
 * words, so transcript alignment works on characters rather than words.
 * Add more entries here as you pick up new languages.
 */
export interface LanguageOption {
  code: string;
  label: string;
  charBased?: boolean;
}

export const LANGUAGES: LanguageOption[] = [
  { code: "auto", label: "Auto-detect" },
  { code: "fr", label: "French" },
  { code: "cy", label: "Welsh" },
  { code: "ja", label: "Japanese", charBased: true },
  { code: "no", label: "Norwegian (Bokmål)" },
  { code: "nn", label: "Norwegian (Nynorsk)" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "sv", label: "Swedish" },
  { code: "da", label: "Danish" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese", charBased: true },
  { code: "en", label: "English" },
];

const CHAR_BASED = new Set(LANGUAGES.filter((l) => l.charBased).map((l) => l.code));

export function isCharBased(code: string | undefined): boolean {
  if (!code) return false;
  const base = normalizeLanguageCode(code) ?? "";
  return CHAR_BASED.has(base) || ["yue", "tha", "th"].includes(base);
}

/** ISO-639-3 codes that speech-to-text may report, mapped to our two-letter codes. */
const ISO3_TO_2: Record<string, string> = {
  fra: "fr", cym: "cy", jpn: "ja", nob: "no", nor: "no", nno: "nn", deu: "de", spa: "es",
  ita: "it", por: "pt", nld: "nl", swe: "sv", dan: "da", kor: "ko", zho: "zh", cmn: "zh", eng: "en",
};

export function normalizeLanguageCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const base = code.toLowerCase().split(/[-_]/)[0];
  return ISO3_TO_2[base] ?? base;
}

export function languageLabel(code: string | undefined): string {
  const norm = normalizeLanguageCode(code);
  if (!norm) return "Unknown";
  return LANGUAGES.find((l) => l.code === norm)?.label ?? code ?? "Unknown";
}
