"""Non-silent chunks of an mp3 with the whisper words that fall in them."""
import json, os, re, subprocess, sys

def chunks(mp3, words_json, noise="-35dB", gap=0.35, fill=None):
    """fill: {start: text} for chunks the whole-file pass missed; defaults to <words_json>.fill.json if present."""
    if fill is None:
        fp = words_json.replace(".json", ".fill.json")
        fill = json.load(open(fp)) if os.path.exists(fp) else {}
    err = subprocess.run(["ffmpeg", "-hide_banner", "-i", mp3, "-af", f"silencedetect=noise={noise}:d={gap}", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", err)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", err)]
    dur = float(re.search(r"Duration: (\d+):(\d+):([\d.]+)", err).groups()[2]) + 60*int(re.search(r"Duration: (\d+):(\d+)", err)[2]) + 3600*int(re.search(r"Duration: (\d+)", err)[1])
    # speech = between silence_end[i] and silence_start[i+1]
    bounds = sorted(zip(starts, ends + [dur]*(len(starts)-len(ends))))
    speech, t = [], 0.0
    for s, e in bounds:
        if s - t > 0.08: speech.append([t, s])
        t = e
    if dur - t > 0.08: speech.append([t, dur])
    words = [w for seg in json.load(open(words_json))["segments"] for w in seg.get("words", [])]
    # each word goes to the chunk nearest its midpoint
    owned = [[] for _ in speech]
    for w in words:
        mid = (w["start"] + w["end"]) / 2
        i = min(range(len(speech)), key=lambda i: 0 if speech[i][0] <= mid <= speech[i][1] else min(abs(mid - speech[i][0]), abs(mid - speech[i][1])))
        owned[i].append(w)
    out = []
    for (a, b), ws in zip(speech, owned):
        text = " ".join(w["word"].strip() for w in ws) or fill.get(str(round(a, 3)), "")
        out.append({"start": round(a, 3), "end": round(b, 3), "text": text, "words": ws})
    return out

if __name__ == "__main__":
    for c in chunks(sys.argv[1], sys.argv[2]):
        print(f'{c["start"]:8.2f} {c["end"]:8.2f}  {c["text"]}')
