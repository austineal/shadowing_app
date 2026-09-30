import { synthesize } from "../tts/client";

/**
 * Synthesises each text in turn with an on-device voice, before a session starts, so nothing
 * has to be generated while the screen may be off. Texts that fail are left out; the player
 * leaves a short pause in their place.
 */
export async function synthesizeAll(
  voiceId: string,
  texts: string[],
  onProgress: (done: number, total: number) => void,
  cancelled: () => boolean,
): Promise<Map<string, AudioBuffer>> {
  const clips = new Map<string, AudioBuffer>();
  let done = 0;
  for (const text of texts) {
    if (cancelled()) break;
    try {
      clips.set(text, await synthesize(voiceId, text));
    } catch {
      /* left out */
    }
    onProgress(++done, texts.length);
  }
  return clips;
}
