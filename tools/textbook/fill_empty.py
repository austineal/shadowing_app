"""Transcribes, one by one, the speech chunks the whole-file pass left without words. Writes {start: text}."""
import json, os, subprocess, sys
import numpy as np, mlx_whisper
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chunks import chunks

MODEL = "mlx-community/whisper-large-v3-turbo"
for mp3, wj, out in zip(sys.argv[1::3], sys.argv[2::3], sys.argv[3::3]):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", mp3, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], capture_output=True).stdout
    audio = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    fill = {}
    for c in chunks(mp3, wj, fill={}):
        if c["text"].strip() or c["end"] - c["start"] < 0.25: continue
        clip = audio[max(0, int((c["start"]-0.1)*16000)):int((c["end"]+0.1)*16000)]
        r = mlx_whisper.transcribe(clip, path_or_hf_repo=MODEL, language="cy", condition_on_previous_text=False, temperature=0.0)
        fill[str(c["start"])] = r["text"].strip()
    json.dump(fill, open(out, "w"), ensure_ascii=False, indent=0)
    print(out, len(fill), flush=True)
