// Throwaway benchmark page for on-device Piper TTS: quality by ear, speed by the numbers.
// Results are saved to users/{uid}/debug/tts-<device> so they can be compared across devices.
import { onAuthStateChanged } from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import "../index.css";
import type { WorkerIn, WorkerOut } from "./worker";

interface VoiceTest {
  voiceId: string;
  label: string;
  texts: string[];
  checked: boolean;
}

const EN_TEXTS = [
  "it's such an incomparably rich period.",
  "and political scientists from across the political spectrum.",
  "and I destroy them as fast as I can, for fear of being found out,",
  "The speaker says this to explain why he called it the golden age: the time was so rich that the name fits.",
];

const VOICES: VoiceTest[] = [
  { voiceId: "en_GB-alba-medium", label: "English (GB) Alba", texts: EN_TEXTS, checked: true },
  { voiceId: "en_GB-cori-high", label: "English (GB) Cori, high quality", texts: EN_TEXTS, checked: false },
  { voiceId: "en_US-lessac-medium", label: "English (US) Lessac", texts: EN_TEXTS, checked: true },
  { voiceId: "en_GB-northern_english_male-medium", label: "English (GB) northern male", texts: EN_TEXTS, checked: false },
  {
    voiceId: "fr_FR-siwis-medium",
    label: "French Siwis",
    texts: ["tellement c'est", "Je n'ai pas fermé l'œil, tellement j'avais peur."],
    checked: true,
  },
  {
    voiceId: "fr_FR-tom-medium",
    label: "French Tom",
    texts: ["tellement c'est", "Je n'ai pas fermé l'œil, tellement j'avais peur."],
    checked: false,
  },
  {
    voiceId: "cy_GB-gwryw_gogleddol-medium",
    label: "Welsh (north, male)",
    texts: ["Mae'n braf heddiw.", "Dw i ddim yn gwybod beth i'w wneud."],
    checked: true,
  },
  {
    voiceId: "no_NO-talesyntese-medium",
    label: "Norwegian",
    texts: ["Det er fint vær i dag.", "Jeg vet ikke hva jeg skal gjøre."],
    checked: false,
  },
];

/** A spoken note: English and French pieces voiced separately and joined. */
const NOTE_PARTS: { lang: "en" | "fr"; text: string }[] = [
  { lang: "en", text: "Here," },
  { lang: "fr", text: "tellement" },
  { lang: "en", text: "means because it's so. For example:" },
  { lang: "fr", text: "Je n'ai pas fermé l'œil, tellement j'avais peur." },
  { lang: "en", text: "I didn't sleep a wink, I was so scared." },
];

interface Row {
  voiceId: string;
  text: string;
  genMs: number;
  phonemeMs?: number;
  inferMs?: number;
  audioSec: number;
}

const app = document.getElementById("app")!;
const ctx = new AudioContext();
const buffers = new Map<string, AudioBuffer>();
const rows: Row[] = [];
const loads: Record<string, number> = {};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, text = ""): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), attrs);
  if (text) e.textContent = text;
  return e;
};

const status = el("p", { className: "muted small" });
const table = el("div", { className: "list" });

function play(buf: AudioBuffer | undefined) {
  if (!buf) return;
  void ctx.resume();
  const n = ctx.createBufferSource();
  n.buffer = buf;
  n.connect(ctx.destination);
  n.start();
}

function runVoice(voiceId: string, texts: string[]): Promise<AudioBuffer[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const out: AudioBuffer[] = [];
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === "progress" && m.total) {
        status.textContent = `${voiceId}: downloading ${Math.round((m.loaded / m.total) * 100)}% of ${(m.total / 1e6).toFixed(0)} MB`;
      } else if (m.type === "loaded") {
        loads[voiceId] = Math.round(m.ms);
        status.textContent = `${voiceId}: loaded in ${(m.ms / 1000).toFixed(1)} s, generating…`;
      } else if (m.type === "result") {
        const buf = ctx.createBuffer(1, m.pcm.length, m.sampleRate);
        buf.copyToChannel(m.pcm as Float32Array<ArrayBuffer>, 0);
        out[m.index] = buf;
        rows.push({
          voiceId,
          text: texts[m.index],
          genMs: Math.round(m.ms),
          phonemeMs: Math.round(m.phonemeMs),
          inferMs: Math.round(m.inferMs),
          audioSec: 0,
        });
      } else if (m.type === "error") {
        worker.terminate();
        reject(new Error(m.message));
      } else if (m.type === "done") {
        worker.terminate();
        resolve(out);
      }
    };
    worker.postMessage({ type: "run", voiceId, texts } satisfies WorkerIn);
  });
}

function renderRow(voiceId: string, text: string, buf: AudioBuffer, genMs: number) {
  const row = rows.find((r) => r.voiceId === voiceId && r.text === text && r.audioSec === 0);
  if (row) row.audioSec = +buf.duration.toFixed(2);
  const card = el("div", { className: "card" });
  const body = el("div", { className: "body" });
  body.append(el("div", { className: "title" }, text));
  body.append(
    el(
      "div",
      { className: "meta" },
      `${voiceId} · generated in ${genMs} ms${row?.inferMs !== undefined ? ` (phonemes ${row.phonemeMs} ms, model ${row.inferMs} ms)` : ""} · ${buf.duration.toFixed(1)} s audio · ${(genMs / 1000 / buf.duration).toFixed(2)}× real time`,
    ),
  );
  const btn = el("button", { className: "btn small", onclick: () => play(buf) }, "▶");
  card.append(body, btn);
  table.append(card);
}

async function runAll(selected: VoiceTest[]) {
  table.replaceChildren();
  rows.length = 0;
  for (const v of selected) {
    try {
      const bufs = await runVoice(v.voiceId, v.texts);
      bufs.forEach((b, i) => {
        buffers.set(`${v.voiceId}|${v.texts[i]}`, b);
        renderRow(v.voiceId, v.texts[i], b, rows.find((r) => r.voiceId === v.voiceId && r.text === v.texts[i])!.genMs);
      });
    } catch (err) {
      table.append(el("p", { className: "error small" }, `${v.voiceId}: ${String(err)}`));
    }
  }
  status.textContent = "Done.";
  await saveResults();
}

/** Voices the note with an English voice and a French voice, joining the pieces with short pauses. */
async function runNote(enVoice: string, frVoice: string) {
  status.textContent = "Generating the spoken note…";
  const en = NOTE_PARTS.filter((p) => p.lang === "en").map((p) => p.text);
  const fr = NOTE_PARTS.filter((p) => p.lang === "fr").map((p) => p.text);
  const t0 = performance.now();
  const [enBufs, frBufs] = [await runVoice(enVoice, en), await runVoice(frVoice, fr)];
  const genMs = Math.round(performance.now() - t0);
  const pieces: AudioBuffer[] = [];
  let ei = 0;
  let fi = 0;
  for (const p of NOTE_PARTS) pieces.push(p.lang === "en" ? enBufs[ei++] : frBufs[fi++]);
  // Mix the pieces on an offline context so each is resampled from its voice's rate (22.05 kHz
  // for Piper medium voices) rather than copied sample-for-sample into a buffer at another rate.
  const gap = 0.18;
  const total = pieces.reduce((t, b) => t + b.duration + gap, 0);
  const mix = new OfflineAudioContext(1, Math.ceil(total * ctx.sampleRate), ctx.sampleRate);
  let at = 0;
  for (const b of pieces) {
    const src = mix.createBufferSource();
    src.buffer = b;
    src.connect(mix.destination);
    src.start(at);
    at += b.duration + gap;
  }
  const joined = await mix.startRendering();
  rows.push({ voiceId: `note:${enVoice}+${frVoice}`, text: NOTE_PARTS.map((p) => p.text).join(" "), genMs, audioSec: +joined.duration.toFixed(2) });
  renderRow(`note:${enVoice}+${frVoice}`, NOTE_PARTS.map((p) => p.text).join(" "), joined, genMs);
  status.textContent = "Done.";
  await saveResults();
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/Android/.test(ua)) return "android";
  if (/Mac/.test(ua)) return "mac";
  return "other";
}

async function saveResults() {
  const user = auth.currentUser;
  if (!user) return;
  await setDoc(doc(db, "users", user.uid, "debug", `tts-${deviceName()}`), {
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency ?? null,
    crossOriginIsolated: self.crossOriginIsolated,
    loads,
    rows,
    at: serverTimestamp(),
  }).catch(() => undefined);
}

function render() {
  app.append(el("h1", {}, "On-device TTS test"));
  app.append(
    el(
      "p",
      { className: "muted small" },
      "Generates sample phrases with Piper voices running in this browser. The first run of each voice downloads it (tens of MB). Timings are saved to your account for comparison.",
    ),
  );
  const list = el("div", { className: "list" });
  for (const v of VOICES) {
    const label = el("label", { className: "row small" });
    const box = el("input", { type: "checkbox", checked: v.checked, onchange: () => (v.checked = box.checked) });
    label.append(box, document.createTextNode(`${v.label} (${v.voiceId})`));
    list.append(label);
  }
  app.append(list);
  const row = el("div", { className: "row wrap" });
  row.append(el("button", { className: "btn primary", onclick: () => void runAll(VOICES.filter((v) => v.checked)) }, "Run selected voices"));
  row.append(el("button", { className: "btn", onclick: () => void runNote("en_GB-alba-medium", "fr_FR-siwis-medium") }, "Spoken note (EN + FR)"));
  app.append(row, status, table);
  onAuthStateChanged(auth, (u) => {
    status.textContent = u ? `Signed in; results will be saved (${deviceName()}).` : "Not signed in; results won't be saved.";
  });
}

render();
