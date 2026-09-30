import { describe, expect, it } from "vitest";
import { clipsToDelete, toFloat32, toInt16 } from "./clipCache";

describe("16-bit clip storage", () => {
  it("round-trips samples to within 16-bit precision", () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 0.123456, -0.999, 1]);
    const back = toFloat32(toInt16(pcm));
    pcm.forEach((v, i) => expect(back[i]).toBeCloseTo(v, 4));
  });
  it("clamps samples outside [-1, 1]", () => {
    expect(Array.from(toInt16(new Float32Array([1.7, -3])))).toEqual([0x7fff, -0x7fff]);
  });
});

describe("clipsToDelete", () => {
  const index = {
    "/__tts/a/1": { used: 100, bytes: 10 },
    "/__tts/a/2": { used: 139, bytes: 10 },
    "/__tts/a/3": { used: 140, bytes: 10 },
    "/__tts/a/4": { used: 190, bytes: 10 },
    "/__tts/a/5": { used: 200, bytes: 10 },
  };
  it("picks clips unused for longer than the keep period", () => {
    expect(clipsToDelete(index, 200, 60, 1000, 800)).toEqual(["/__tts/a/1", "/__tts/a/2"]);
    expect(clipsToDelete(index, 200, 100, 1000, 800)).toEqual([]);
  });
  it("then evicts the least recently used until the store is back under its target", () => {
    // Three clips (30 bytes) remain after the stale ones; over a 25-byte cap, down to 15.
    expect(clipsToDelete(index, 200, 60, 25, 15)).toEqual(["/__tts/a/1", "/__tts/a/2", "/__tts/a/3", "/__tts/a/4"]);
  });
});
