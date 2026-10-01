/** Audio for decks: decoding each card's clips to PCM, and encoding the joined cards as CBR MP3. */
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const run = promisify(execFile);
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;

/** Sample rate of the PCM (mono, 16-bit) and of the deck's MP3. */
export const RATE = 44_100;
const BITRATE = "96k";

/**
 * Decodes a clip to mono 16-bit PCM, trimming silence from both ends (keeping 50 ms) so the
 * drill's own pauses set the timing.
 */
export async function decode(dir: string, name: string, audio: Buffer): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("ffmpeg is not available on this platform.");
  const input = join(dir, `${name}.in`);
  const output = join(dir, `${name}.pcm`);
  await writeFile(input, audio);
  const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05";
  await run(
    ffmpegPath,
    ["-v", "error", "-y", "-i", input, "-map", "0:a:0", "-af", `${trim},areverse,${trim},areverse`, "-ac", "1", "-ar", String(RATE), "-f", "s16le", output],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const pcm = await readFile(output);
  await Promise.all([rm(input, { force: true }), rm(output, { force: true })]);
  return pcm;
}

export async function encode(dir: string, pcm: Buffer): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("ffmpeg is not available on this platform.");
  const input = join(dir, "deck.pcm");
  const output = join(dir, "deck.mp3");
  await writeFile(input, pcm);
  // A file (not a pipe) so the encoder writes its LAME header, which keeps the timeline exact.
  await run(
    ffmpegPath,
    ["-v", "error", "-y", "-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", input, "-c:a", "libmp3lame", "-b:a", BITRATE, output],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return readFile(output);
}

