"""Turns a course book's unit audio into shadowing-app material: vocab decks, phrase decks and dialogue episodes.

usage:
  build.py analyse <book.json> <audio pattern with {n}> <transcripts dir> <out dir> --units 1-28
  build.py cut     <book.json> <audio pattern with {n}> <transcripts dir> <out dir> --units 1-28 [--part 7]

'analyse' aligns everything and writes <out>/.analysis.json and <out>/review.txt; 'cut' writes the clips,
CSVs and dialogue MP3s from that analysis.
"""
import argparse, csv, json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chunks import chunks
from align_vocab import unit_cards, norm
from align_pairs import unit_sentences
from dialogues import spans as dialogue_spans

ap = argparse.ArgumentParser()
ap.add_argument("mode", choices=["analyse", "cut"])
ap.add_argument("book"); ap.add_argument("audio"); ap.add_argument("tx"); ap.add_argument("out")
ap.add_argument("--units", required=True, help="e.g. 1-28")
ap.add_argument("--part", type=int, default=7, help="units per deck/episode")
A = ap.parse_args()
lo_u, hi_u = map(int, A.units.split("-"))
UNITS = range(lo_u, hi_u + 1)
mp3 = lambda n: A.audio.format(n=n)
wj = lambda n: os.path.join(A.tx, os.path.splitext(os.path.basename(mp3(n)))[0] + ".json")
os.makedirs(A.out, exist_ok=True)
ANALYSIS = os.path.join(A.out, ".analysis.json")

def analyse():
    book = json.load(open(A.book))
    res, review = {}, []
    for n in UNITS:
        vc = unit_cards(n, mp3(n), wj(n), book["vocab"])
        taken = [tuple(c[k]) for c in vc if not c.get("missing") for k in ("cy_t", "en_t")]
        ps = [dict(p, unit=n) if p["unit"] is None else p for p in book["pairs"]]
        sc = unit_sentences(n, mp3(n), wj(n), ps, taken)
        dl = dialogue_spans(chunks(mp3(n), wj(n)))
        res[n] = {"vocab": vc, "sentences": sc, "dialogues": dl}
        found = [c for c in vc if not c.get("missing")]
        line = f"Unit {n}: vocab {len(found)}/{len(vc)}, sentences {len(sc)}, dialogues {len(dl)} ({sum(b - a for _, a, b in dl):.0f}s)"
        print(line, flush=True)
        review.append(line)
        review += [f"  not found: {c['cy']} / {c['en']}" for c in vc if c.get("missing")]
        review += [f"  check: {c['cy']} / {c['en']} at {c['cy_t'][0]:.1f}s (heard '{c['cy_heard']}' / '{c['en_heard']}')"
                   for c in found if max(c["cy_sim"], c["en_sim"]) < 0.6]
        review += [f"  {k} {a:.1f}-{b:.1f}s" for k, a, b in dl]
    json.dump(res, open(ANALYSIS, "w"), ensure_ascii=False, indent=0)
    open(os.path.join(A.out, "review.txt"), "w").write("\n".join(review) + "\n")

def cut(src, a, b, dst):
    a = max(0, a - 0.08); b = b + 0.15
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", src,
                    "-af", f"afade=t=in:d=0.02,afade=t=out:st={b - a - 0.03:.3f}:d=0.03", "-ac", "1", "-ar", "44100", "-b:a", "128k", dst], check=True)

def vocab_text(c):
    g = {"f": "f", "m": "m"}.get(c["cat"])
    if not g: return c["cy"]
    return f'{c["cy"]} ({g} pl)' if c["form"] == "pl" else f'{c["cy"]} ({g})'

def write_csv(path, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f); w.writerow(["audio", "english audio", "sentence", "english", "unit"]); w.writerows(rows)

def build():
    res = {int(k): v for k, v in json.load(open(ANALYSIS)).items()}
    seen = set()
    for lo in range(UNITS.start, UNITS.stop, A.part):
        hi = min(lo + A.part - 1, UNITS.stop - 1)
        tag = f"Unedau {lo}-{hi}"
        d = os.path.join(A.out, f"Geirfa {tag}"); os.makedirs(d, exist_ok=True)
        rows = []
        for n in range(lo, hi + 1):
            for i, c in enumerate(x for x in res[n]["vocab"] if not x.get("missing")):
                key = (norm(c["cy"]), norm(c["en"]))
                if key in seen: continue
                seen.add(key)
                base = f"u{n:02d}-g{i:03d}"
                cut(mp3(n), *c["cy_t"], f"{d}/{base}.mp3"); cut(mp3(n), *c["en_t"], f"{d}/{base}-en.mp3")
                rows.append([f"{base}.mp3", f"{base}-en.mp3", vocab_text(c), c["en"], n])
        write_csv(f"{d}/geirfa.csv", rows)
        d = os.path.join(A.out, f"Ymadroddion {tag}"); os.makedirs(d, exist_ok=True)
        rows = []
        for n in range(lo, hi + 1):
            for i, c in enumerate(res[n]["sentences"]):
                key = norm(c["cy"])
                if key in seen: continue
                seen.add(key)
                base = f"u{n:02d}-y{i:03d}"
                cut(mp3(n), *c["cy_t"], f"{d}/{base}.mp3")
                en = ""
                if "en_t" in c:
                    en = f"{base}-en.mp3"; cut(mp3(n), *c["en_t"], f"{d}/{en}")
                rows.append([f"{base}.mp3", en, c["cy"], c["en"], n])
        write_csv(f"{d}/ymadroddion.csv", rows)
        # every dialogue and radio piece in order, 2 s apart, 4 s between units
        inputs, filt = [], []
        for n in range(lo, hi + 1):
            dl = res[n]["dialogues"]
            for j, (_, a, b) in enumerate(dl):
                k = len(filt)
                inputs += ["-ss", f"{max(0, a - 0.2):.3f}", "-to", f"{b + 0.4:.3f}", "-i", mp3(n)]
                filt.append(f"[{k}:a]aformat=sample_rates=44100:channel_layouts=mono,apad=pad_dur={4 if j == len(dl) - 1 else 2}[s{k}]")
        if filt:
            graph = ";".join(filt) + ";" + "".join(f"[s{i}]" for i in range(len(filt))) + f"concat=n={len(filt)}:v=0:a=1[out]"
            subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", graph, "-map", "[out]",
                            "-ac", "1", "-ar", "44100", "-b:a", "128k", os.path.join(A.out, f"Sgyrsiau {tag}.mp3")], check=True)
        print(tag, "done", flush=True)

analyse() if A.mode == "analyse" else build()
