/** Translations and study notes for transcript phrases, written by Claude. */
import Anthropic from "@anthropic-ai/sdk";

export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

export function isBelow(a: CefrLevel, b: CefrLevel): boolean {
  return CEFR_LEVELS.indexOf(a) < CEFR_LEVELS.indexOf(b);
}

export const NOTE_KINDS = ["grammar", "idiom", "vocab", "culture", "pronunciation", "transcription"] as const;

export interface StudyNote {
  kind: (typeof NOTE_KINDS)[number];
  /** Exact substring of the phrase the note is about. */
  span: string;
  title: string;
  body: string;
  /** CEFR level at which learners typically meet this point. */
  level: CefrLevel;
}

export interface PhraseStudy {
  translation: string;
  /** Word-for-word rendering, or "" when it adds nothing over the translation. */
  literal: string;
  notes: StudyNote[];
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["phrases"],
  properties: {
    phrases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "translation", "literal", "notes"],
        properties: {
          id: { type: "string" },
          translation: { type: "string" },
          literal: { type: "string" },
          notes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "span", "title", "body", "level"],
              properties: {
                kind: { type: "string", enum: [...NOTE_KINDS] },
                span: { type: "string" },
                title: { type: "string" },
                body: { type: "string" },
                level: { type: "string", enum: [...CEFR_LEVELS] },
              },
            },
          },
        },
      },
    },
  },
} as const;

function instructions(languageName: string): string {
  return `You are helping an English speaker study a ${languageName} podcast by shadowing it phrase by phrase: they hear a phrase, repeat it aloud, then move on. The full transcript is below. You will be given a batch of phrases from it, along with the learner's CEFR level, and you return study material for each phrase.

For each phrase:
- translation: natural, idiomatic English for that phrase alone, read in the context of the surrounding transcript. Phrases are often sentence fragments; translate the fragment rather than completing it from its neighbours. This text will be read aloud straight after the original, so keep it about as short as the original and do not add brackets, explanations or alternatives.
- literal: a word-for-word rendering when it shows how the ${languageName} is built in a way the natural translation hides. Otherwise an empty string.
- notes: explanations of what a learner at the given level would probably not understand from the words alone. That includes grammar above their level, idioms and fixed expressions, colloquial or regional usage, cultural references, and features of fast speech (contractions, elision, dropped words, mutations and the like) that make the audio differ from the textbook form. Pitch each explanation at the learner's level, in English, in one to three sentences, and set its level to the CEFR level at which learners usually meet that point. Leave out anything below the learner's level; many phrases need no notes at all, and an empty list is the right answer for them. The learner studies the whole episode in order, so explain a recurring point (a dropped "ne", say) only where it first occurs in the transcript, not again in later phrases. The transcript comes from speech recognition, so if a phrase looks misrecognised, translate what was most likely said and add a "transcription" note saying what you think the speaker said.
- span in each note must be copied exactly from the phrase text.

Return one entry per phrase, with the id it was given.

<transcript>
`;
}

export interface StudyRequest {
  apiKey: string;
  model: string;
  languageName: string;
  level: CefrLevel;
  /** Full episode transcript, one phrase per line. Identical across batches so it caches. */
  transcript: string;
  phrases: string[];
}

/** Returns study material for each phrase, in the order given. */
export async function studyPhrases(req: StudyRequest): Promise<PhraseStudy[]> {
  const client = new Anthropic({ apiKey: req.apiKey });
  const ids = req.phrases.map((_, i) => `p${i + 1}`);
  const list = req.phrases.map((p, i) => `${ids[i]}: ${p}`).join("\n");

  const message = await client.beta.messages
    .stream({
      model: req.model,
      max_tokens: 32000,
      // Re-run on another model if a safety classifier declines, instead of failing the batch.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: [
        { type: "text", text: instructions(req.languageName) },
        { type: "text", text: `${req.transcript}\n</transcript>`, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: `Learner level: ${req.level}\n\nPhrases:\n${list}` }],
    })
    .finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(`Claude declined this batch (${message.stop_details?.category ?? "no category"}).`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Claude's reply was cut off at the token limit.");
  }
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Claude returned no text.");
  const parsed = JSON.parse(text) as { phrases: (PhraseStudy & { id: string })[] };

  const byId = new Map(parsed.phrases.map((p) => [p.id, p]));
  return ids.map((id, i) => {
    const p = byId.get(id);
    if (!p) throw new Error(`Claude returned no entry for phrase ${id}.`);
    // Drop notes whose span isn't actually in the phrase (the UI highlights spans by exact match),
    // and points below the learner's level. Transcription notes are about the text, so they stay.
    const notes = p.notes.filter(
      (n) => req.phrases[i].includes(n.span) && (n.kind === "transcription" || !isBelow(n.level, req.level)),
    );
    return { translation: p.translation.trim(), literal: p.literal.trim(), notes };
  });
}

export interface ThreadEntry {
  role: "user" | "assistant";
  text: string;
}

export interface ExplainRequest {
  apiKey: string;
  model: string;
  languageName: string;
  level: CefrLevel;
  phrase: string;
  translation: string;
  /** Neighbouring transcript lines, with the phrase itself in place. */
  context: string;
  notes: StudyNote[];
  /** Earlier questions and answers about this phrase. */
  history: ThreadEntry[];
  request: string;
}

/** Answers a follow-up question about a phrase. Returns plain text. */
export async function explain(req: ExplainRequest): Promise<string> {
  const client = new Anthropic({ apiKey: req.apiKey });
  const notes = req.notes.map((n) => `- "${n.span}" (${n.kind}, ${n.level}): ${n.title}. ${n.body}`).join("\n");
  const background = `Phrase: ${req.phrase}
Translation: ${req.translation}
${notes ? `Notes already shown to the learner:\n${notes}\n` : ""}
Surrounding transcript:
${req.context}`;

  // The background rides on the first user turn so later turns read as a normal conversation.
  const turns: ThreadEntry[] = [...req.history, { role: "user", text: req.request }];
  const messages = turns.map((t, i) => ({
    role: t.role,
    content: i === 0 ? `${background}\n\n${t.text}` : t.text,
  }));

  const message = await client.beta.messages
    .stream({
      model: req.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: `You are a patient ${req.languageName} tutor. An English speaker at CEFR ${req.level} is shadowing a podcast phrase by phrase and has a question about one phrase. Answer in English, pitched at their level, in a short paragraph or two unless they ask for more. Short ${req.languageName} examples with English translations help. Write plain text with blank lines between paragraphs: no headings, bold or bullet markup.`,
      messages,
    })
    .finalMessage();

  if (message.stop_reason === "refusal") throw new Error("Claude declined to answer this one.");
  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("Claude returned no answer.");
  return text;
}
