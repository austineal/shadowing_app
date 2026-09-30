import { englishClip } from "../tts/clipCache";

/**
 * Gets every text's English clip before a session starts, from those stored on this device where
 * possible and otherwise synthesising (and storing) them, so nothing has to be generated while
 * the screen may be off. Texts that fail are left out; the player leaves a short pause instead.
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
      clips.set(text, await englishClip(voiceId, text));
    } catch {
      /* left out */
    }
    onProgress(++done, texts.length);
  }
  return clips;
}
