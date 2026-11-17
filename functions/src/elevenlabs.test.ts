// Run: npm --prefix functions run build && node --test functions/lib/elevenlabs.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "./elevenlabs.js";

test("chunkText keeps sentences whole and every piece under the limit", () => {
  const text = "Bore da. Sut wyt ti heddiw? Dw i'n dda iawn, diolch. ".repeat(20);
  const chunks = chunkText(text, 100);
  assert.ok(chunks.every((c) => c.length <= 100));
  assert.ok(chunks.every((c) => /[.?]$/.test(c)));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), text.trim().replace(/\s+/g, " "));
});

test("chunkText breaks an overlong sentence between words, or anywhere without spaces", () => {
  assert.ok(chunkText("word ".repeat(100), 30).every((c) => c.length <= 30));
  assert.deepEqual(chunkText("あ".repeat(25), 10), ["あ".repeat(10), "あ".repeat(10), "あ".repeat(5)]);
});
