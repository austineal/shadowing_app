/** ffmpeg work: making episode audio seekable, and decoding/encoding deck audio. */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const run = promisify(execFile);
/** Path to the bundled ffmpeg binary (a CommonJS module whose export is the path). */
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;

async function ffmpeg(args: string[]): Promise<void> {
  if (!ffmpegPath) throw new Error("ffmpeg is not available on this platform.");
  await run(ffmpegPath, ["-v", "error", "-y", ...args], { maxBuffer: 16 * 1024 * 1024 });
}

/** Bitrate for re-encoded audio: plenty for speech, and about half a typical podcast file. */
const CBR_BITRATE = "128k";

/**
 * Whether the bytes are an MP3 whose first frame carries a VBR header (Xing or VBRI).
 * Browsers seek in these with the header's coarse table of contents, which can be badly wrong:
 * one 45-minute episode landed 12 s early to 49 s late. CBR files (whose header says "Info")
 * are seeked by arithmetic and land exactly.
 */
export function isVbrMp3(audio: Buffer): boolean {
  let pos = 0;
  if (audio.subarray(0, 3).toString("latin1") === "ID3" && audio.length >= 10) {
    pos = 10 + ((audio[6] << 21) | (audio[7] << 14) | (audio[8] << 7) | audio[9]);
  }
  // Find the first frame sync after any tag, then look for the VBR header inside that frame.
  const limit = Math.min(audio.length - 1, pos + 64 * 1024);
  while (pos < limit && !(audio[pos] === 0xff && (audio[pos + 1] & 0xe0) === 0xe0)) pos++;
  if (pos >= limit) return false;
  const frame = audio.subarray(pos, pos + 200).toString("latin1");
  return frame.includes("Xing") || frame.includes("VBRI");
}

/** Re-encodes audio as constant-bitrate MP3 so every browser seeks in it accurately. */
export async function toCbrMp3(audio: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "normalize-"));
  try {
    const input = join(dir, "in");
    const output = join(dir, "out.mp3");
    await writeFile(input, audio);
    // Files (not pipes) so the encoder can write its LAME header, which tells decoders to trim
    // the encoder delay and keeps the timeline aligned with the original to within a few ms.
    await ffmpeg(["-i", input, "-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", CBR_BITRATE, output]);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Sample rate of deck PCM (mono, 16-bit) and of the deck's MP3. */
export const RATE = 44_100;
const DECK_BITRATE = "96k";

/**
 * Decodes a clip to mono 16-bit PCM, trimming silence from both ends (keeping 50 ms) so the
 * drill's own pauses set the timing.
 */
export async function decode(dir: string, name: string, audio: Buffer): Promise<Buffer> {
  const input = join(dir, `${name}.in`);
  const output = join(dir, `${name}.pcm`);
  await writeFile(input, audio);
  const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05";
  await ffmpeg(["-i", input, "-map", "0:a:0", "-af", `${trim},areverse,${trim},areverse`, "-ac", "1", "-ar", String(RATE), "-f", "s16le", output]);
  const pcm = await readFile(output);
  await Promise.all([rm(input, { force: true }), rm(output, { force: true })]);
  return pcm;
}

export async function encode(dir: string, pcm: Buffer): Promise<Buffer> {
  const input = join(dir, "deck.pcm");
  const output = join(dir, "deck.mp3");
  await writeFile(input, pcm);
  // A file (not a pipe) so the encoder writes its LAME header, which keeps the timeline exact.
  await ffmpeg(["-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", input, "-c:a", "libmp3lame", "-b:a", DECK_BITRATE, output]);
  return readFile(output);
}
