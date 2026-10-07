"""Finds the book's Welsh/English sentence pairs in a unit's audio (Welsh clip, plus the English clip if it's read next)."""
import json, re, sys, os
from itertools import product
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chunks import chunks
from align_vocab import sim, norm

def wsim(heard, book):
    """Word-level similarity: heard words snapped to the closest book word, then sequence-matched."""
    from difflib import SequenceMatcher
    b = [norm(w) for w in re.split(r"[\s’'-]+", book) if norm(w)]
    h = [norm(w) for w in re.split(r"[\s’'-]+", heard) if norm(w)]
    if not b or not h: return 0.0
    snap = lambda w: max(b, key=lambda x: SequenceMatcher(None, w, x).ratio()) if max(SequenceMatcher(None, w, x).ratio() for x in b) >= 0.7 else w
    return SequenceMatcher(None, [snap(w) for w in h], b).ratio()

def covered(a, b, minlen):
    """Fraction of a's words (length >= minlen) with a fuzzy match in b."""
    from difflib import SequenceMatcher
    a = [norm(w) for w in re.split(r"[\s’'-]+", a) if len(norm(w)) >= minlen]
    b = [norm(w) for w in re.split(r"[\s’'-]+", b) if norm(w)]
    if not a: return 1.0
    return sum(any(SequenceMatcher(None, w, x).ratio() >= 0.6 for x in b) for w in a) / len(a)

def score(heard, book):
    if covered(book, heard, 4) < 1 or covered(heard, book, 3) < 0.8: return 0.0
    return min(sim(heard, book), wsim(heard, book))

def variants(cy):
    """'Dw i’n lico/hoffi coffi.' -> each reading: ['Dw i’n lico coffi.', 'Dw i’n hoffi coffi.']"""
    parts = re.split(r"(\S+/\S+)", cy)
    opts = [p.split("/") if "/" in p and not p.startswith("(") else [p] for p in parts]
    return ["".join(o) for o in product(*opts)][:8]

def spans(ch, j, maxk=4):
    for k in range(1, maxk+1):
        if j + k > len(ch) or (k > 1 and ch[j+k-1]["start"] - ch[j+k-2]["end"] > 1.2): break
        yield j, k, " ".join(x["text"] for x in ch[j:j+k])

def unit_sentences(unit, mp3, words_json, pairs, taken):
    """taken: (start, end) times already used by vocab cards."""
    ch = chunks(mp3, words_json)
    free = [not any(a <= c["start"] < b for a, b in taken) for c in ch]
    ps = [p for p in pairs if p["unit"] == unit and len(norm(p["cy"])) >= 6]
    cands = []
    for pi, p in enumerate(ps):
        vs = variants(p["cy"])
        for j in range(len(ch)):
            if not free[j]: continue
            for _, k, text in spans(ch, j):
                if not all(free[j:j+k]): break
                v, s = max(((v, score(text, v)) for v in vs), key=lambda x: x[1])
                if s >= 0.75: cands.append((s, pi, j, k, v, text))
    used, done, out = set(), set(), []
    for s, pi, j, k, v, text in sorted(cands, key=lambda c: (-c[0], c[3])):
        key = (pi, v)
        if key in done or set(range(j, j+k)) & used: continue
        done.add(key); used |= set(range(j, j+k))
        p = ps[pi]
        card = {"unit": unit, "page": p["page"], "cy": v.strip(), "en": p["en"], "book_cy": p["cy"], "sim": round(s, 2),
                "heard": text, "cy_t": [ch[j]["start"], ch[j+k-1]["end"]]}
        n = j + k
        if n < len(ch) and n not in used and ch[n]["start"] - ch[n-1]["end"] < 2.5:
            for _, k2, t2 in spans(ch, n, 3):
                if sim(t2, p["en"]) >= 0.75:
                    card["en_t"] = [ch[n]["start"], ch[n+k2-1]["end"]]; used |= set(range(n, n+k2)); break
        out.append(card)
    return sorted(out, key=lambda c: c["cy_t"][0])

if __name__ == "__main__":
    unit, mp3, wj, pj = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
    taken = [tuple(c[k]) for c in json.load(open(sys.argv[5])) if not c.get("missing") for k in ("cy_t", "en_t")] if len(sys.argv) > 5 else []
    book = json.load(open(pj)); pairs = book["pairs"] if isinstance(book, dict) else book
    res = unit_sentences(unit, mp3, wj, [dict(p, unit=unit) if p["unit"] is None else p for p in pairs], taken)
    for c in res:
        print(f'{c["cy_t"][0]:7.1f} {c["sim"]:.2f} {"EN" if "en_t" in c else "  "} {c["cy"]:45} | {c["en"]:35} [{c["heard"]}]')
    print(len(res), "of", len([p for p in pairs if p["unit"] == unit]))
