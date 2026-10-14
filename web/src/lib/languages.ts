/**
 * Languages offered in the import UI: everything ElevenLabs Scribe transcribes
 * (https://elevenlabs.io/docs/capabilities/speech-to-text), as listed there in
 * ISO-639-3. We store and send the canonical (usually two-letter) code, which
 * is what older episodes already use. `CHAR_BASED` languages have no spaces
 * between words, so transcript alignment works on characters rather than words.
 */
const SCRIBE_CODES = (
  "afr amh ara hye asm ast aze bel ben bos bul mya yue cat ceb nya hrv ces dan nld eng est fil fin " +
  "fra ful glg lug kat deu ell guj hau heb hin hun isl ibo ind gle ita jpn jav kea kan kaz khm kor " +
  "kur kir lao lav lin lit luo ltz mkd msa mal mlt zho mri mar mon nep nso nor oci ori pus fas pol " +
  "por pan ron rus srp sna snd sin slk slv som spa swa swe tam tgk tel tha tur ukr umb urd uzb vie " +
  "cym wol xho zul"
).split(" ");

const names = new Intl.DisplayNames(["en"], { type: "language" });

export const LANGUAGES: { code: string; label: string }[] = [
  { code: "auto", label: "Auto-detect" },
  ...SCRIBE_CODES.map((c) => normalizeLanguageCode(c)!)
    .map((code) => ({ code, label: names.of(code) ?? code }))
    .sort((a, b) => a.label.localeCompare(b.label)),
];

const CHAR_BASED = new Set(["ja", "zh", "yue", "th", "lo", "km", "my"]);

export function isCharBased(code: string | undefined): boolean {
  return CHAR_BASED.has(normalizeLanguageCode(code) ?? "");
}

/** Maps whatever speech-to-text reports ("fra", "cmn", "fr-FR") to the code we store ("fr", "zh"). Bokmål and Nynorsk are both "no". */
export function normalizeLanguageCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const base = code.toLowerCase().split(/[-_]/)[0];
  try {
    const canon = Intl.getCanonicalLocales(base)[0];
    return canon === "nb" || canon === "nn" ? "no" : canon;
  } catch {
    return base;
  }
}

export function languageLabel(code: string | undefined): string {
  const norm = normalizeLanguageCode(code);
  if (!norm) return "Unknown";
  return LANGUAGES.find((l) => l.code === norm)?.label ?? code ?? "Unknown";
}
