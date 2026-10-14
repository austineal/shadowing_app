/**
 * Languages offered in the import UI: everything ElevenLabs Scribe transcribes,
 * with names and ISO-639-3 codes as listed at
 * https://elevenlabs.io/docs/capabilities/speech-to-text. We store and send the
 * canonical (usually two-letter) code, which is what older episodes already use.
 * Names are spelled out because browsers' Intl.DisplayNames lacks rarer ones
 * (Fulah, Luo, Umbundu…). `CHAR_BASED` languages have no spaces between words,
 * so transcript alignment works on characters rather than words.
 */
const SCRIBE_LANGUAGES = `afr Afrikaans, amh Amharic, ara Arabic, hye Armenian, asm Assamese, ast Asturian,
aze Azerbaijani, bel Belarusian, ben Bengali, bos Bosnian, bul Bulgarian, mya Burmese, yue Cantonese,
cat Catalan, ceb Cebuano, nya Chichewa, hrv Croatian, ces Czech, dan Danish, nld Dutch, eng English,
est Estonian, fil Filipino, fin Finnish, fra French, ful Fulah, glg Galician, lug Ganda, kat Georgian,
deu German, ell Greek, guj Gujarati, hau Hausa, heb Hebrew, hin Hindi, hun Hungarian, isl Icelandic,
ibo Igbo, ind Indonesian, gle Irish, ita Italian, jpn Japanese, jav Javanese, kea Kabuverdianu,
kan Kannada, kaz Kazakh, khm Khmer, kor Korean, kur Kurdish, kir Kyrgyz, lao Lao, lav Latvian,
lin Lingala, lit Lithuanian, luo Luo, ltz Luxembourgish, mkd Macedonian, msa Malay, mal Malayalam,
mlt Maltese, zho Mandarin Chinese, mri Māori, mar Marathi, mon Mongolian, nep Nepali, nso Northern Sotho,
nor Norwegian, oci Occitan, ori Odia, pus Pashto, fas Persian, pol Polish, por Portuguese, pan Punjabi,
ron Romanian, rus Russian, srp Serbian, sna Shona, snd Sindhi, sin Sinhala, slk Slovak, slv Slovenian,
som Somali, spa Spanish, swa Swahili, swe Swedish, tam Tamil, tgk Tajik, tel Telugu, tha Thai,
tur Turkish, ukr Ukrainian, umb Umbundu, urd Urdu, uzb Uzbek, vie Vietnamese, cym Welsh, wol Wolof,
xho Xhosa, zul Zulu`;

export const LANGUAGES: { code: string; label: string }[] = [
  { code: "auto", label: "Auto-detect" },
  ...SCRIBE_LANGUAGES.split(/,\s*/).map((entry) => {
    const [iso3, ...name] = entry.split(" ");
    return { code: normalizeLanguageCode(iso3)!, label: name.join(" ") };
  }),
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
