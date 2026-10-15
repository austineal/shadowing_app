"""Aligns a unit's book vocab (Welsh form, English, [plural, plurals]) to the unit audio's speech chunks."""
import json, re, sys, os, unicodedata
from difflib import SequenceMatcher
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chunks import chunks
from forms import split_forms, split_en

HEAD = {"f": ("enwau benywaidd", "feminine nouns"), "m": ("enwau gwrywaidd", "masculine nouns"),
        "verb": ("berfau", "verbs"), "adj": ("ansoddeiriau", "adjectives"), "other": ("arall", "other")}

def norm(s):
    s = unicodedata.normalize("NFKD", s.lower())
    return re.sub(r"[^a-z]", "", s)

def sim(a, b):
    a, b = norm(a), norm(b)
    if not a: return 0.35
    if not b: return 0.0
    return SequenceMatcher(None, a, b).ratio()

def expected(entries):
    toks, last = [], None
    for k, e in enumerate(entries):
        if e["cat"] != last:
            last = e["cat"]
            toks += [{"text": HEAD[last][0], "head": True}, {"text": HEAD[last][1], "head": True}]
        sg, pl = split_forms(e["cy"])
        esg, epl = split_en(e["en"])
        if pl and not epl: esg, epl = e["en"], e["en"]
        toks += [{"text": sg, "entry": k, "form": "sg", "role": "cy"}, {"text": esg, "entry": k, "form": "sg", "role": "en"}]
        if pl:
            toks += [{"text": pl, "entry": k, "form": "pl", "role": "cy"}, {"text": epl or esg, "entry": k, "form": "pl", "role": "en"}]
    return toks

def align(toks, ch):
    INF = 1e18
    n, m = len(toks), len(ch)
    SKIP_CH, SKIP_TOK = 0.7, 0.9
    # cost[i][j]: best cost having consumed i tokens and j chunks; free leading chunk skips
    cost = [[INF]*(m+1) for _ in range(n+1)]
    back = [[None]*(m+1) for _ in range(n+1)]
    for j in range(m+1): cost[0][j] = 0.0
    for i in range(n+1):
        for j in range(m+1):
            c = cost[i][j]
            if c >= INF: continue
            if i < n and c + SKIP_TOK < cost[i+1][j]:
                cost[i+1][j], back[i+1][j] = c + SKIP_TOK, (i, j, "skiptok")
            if j < m and i > 0 and c + SKIP_CH < cost[i][j+1]:
                cost[i][j+1], back[i][j+1] = c + SKIP_CH, (i, j, "skipch")
            if i < n:
                for k in (1, 2, 3):
                    if j + k > m: break
                    if k > 1 and ch[j+k-1]["start"] - ch[j+k-2]["end"] > 1.2: break
                    s = sim(" ".join(x["text"] for x in ch[j:j+k]), toks[i]["text"])
                    nc = c + (1 - s) + 0.2*(k-1)
                    if nc < cost[i+1][j+k]:
                        cost[i+1][j+k], back[i+1][j+k] = nc, (i, j, k, s)
    j = min(range(m+1), key=lambda j: cost[n][j])  # free trailing skips
    i, res = n, {}
    while i > 0:
        b = back[i][j]
        if b[2] == "skiptok": i, j = b[0], b[1]; continue
        if b[2] == "skipch": i, j = b[0], b[1]; continue
        pi, pj, k, s = b
        res[pi] = (ch[pj]["start"], ch[pj+k-1]["end"], s, " ".join(x["text"] for x in ch[pj:pj+k]))
        i, j = pi, pj
    return res

def forms(entries):
    out = []
    for k, e in enumerate(entries):
        sg, pl = split_forms(e["cy"])
        esg, epl = split_en(e["en"])
        if pl and not epl: epl = e["en"]
        out.append({"entry": k, "form": "sg", "cy": sg, "en": esg})
        if pl: out.append({"entry": k, "form": "pl", "cy": pl, "en": epl or esg})
    return out

def spans(ch, j, maxk=2):
    """Chunk spans starting at j: (j, k, start, end, text)."""
    for k in range(1, maxk+1):
        if j + k > len(ch) or (k > 1 and ch[j+k-1]["start"] - ch[j+k-2]["end"] > 1.0): break
        yield (j, k, ch[j]["start"], ch[j+k-1]["end"], " ".join(x["text"] for x in ch[j:j+k]))

def unit_cards(unit, mp3, words_json, vocab):
    entries = [e for e in vocab if e["unit"] == unit and e["cy"] and e["en"]]
    fs = forms(entries)
    ch = chunks(mp3, words_json)
    cands = []
    for j in range(len(ch)):
        for a in spans(ch, j):
            nj = j + a[1]
            if nj >= len(ch) or ch[nj]["start"] - a[3] > 2.5: continue
            for b in spans(ch, nj):
                for fi, f in enumerate(fs):
                    sc, se = sim(a[4], f["cy"]), sim(b[4], f["en"])
                    if max(sc, se) < 0.6 or sc + se < 1.1: continue
                    cands.append((sc + se - 0.1*(a[1]+b[1]-2), fi, a, b, sc, se))
    # vocab window: largest cluster of confident matches
    conf = sorted(c[2][2] for c in cands if c[0] > 1.7)
    clusters, cur = [], []
    for t in conf:
        if cur and t - cur[-1] > 60: clusters.append(cur); cur = []
        cur.append(t)
    if cur: clusters.append(cur)
    lo, hi = (lambda c: (c[0] - 30, c[-1] + 30))(max(clusters, key=len)) if clusters else (0, 1e9)
    used_ch, used_f, cards = set(), set(), []
    for score, fi, a, b, sc, se in sorted(cands, key=lambda c: -c[0]):
        if not lo <= a[2] <= hi or fi in used_f: continue
        idx = set(range(a[0], a[0]+a[1])) | set(range(b[0], b[0]+b[1]))
        if idx & used_ch: continue
        used_ch |= idx; used_f.add(fi)
        f, e = fs[fi], entries[fs[fi]["entry"]]
        cards.append({"unit": unit, "entry": f["entry"], "cat": e["cat"], "form": f["form"], "cy": f["cy"], "en": f["en"],
                      "book_cy": e["cy"], "book_en": e["en"], "cy_t": [a[2], a[3]], "en_t": [b[2], b[3]],
                      "cy_sim": round(sc, 2), "en_sim": round(se, 2), "cy_heard": a[4], "en_heard": b[4]})
    # fill: an unmatched form whose book neighbours matched, with exactly two unused chunks between them
    by_f = {(c["entry"], c["form"]): c for c in cards}
    key = lambda f: (f["entry"], f["form"])
    for fi, f in enumerate(fs):
        if fi in used_f or fi == 0 or fi + 1 >= len(fs): continue
        p, n = by_f.get(key(fs[fi-1])), by_f.get(key(fs[fi+1]))
        if not p or not n or not p["en_t"][1] < n["cy_t"][0]: continue
        heading = lambda c: max(sim(c["text"], h) for pair in HEAD.values() for h in pair) >= 0.7  # 'Berfau / verbs'
        free = [i for i, c in enumerate(ch) if p["en_t"][1] <= c["start"] and c["end"] <= n["cy_t"][0] and i not in used_ch and not heading(c)]
        if len(free) != 2: continue
        a, b = ch[free[0]], ch[free[1]]
        used_f.add(fi); used_ch |= set(free)
        e = entries[f["entry"]]
        cards.append({"unit": unit, "entry": f["entry"], "cat": e["cat"], "form": f["form"], "cy": f["cy"], "en": f["en"],
                      "book_cy": e["cy"], "book_en": e["en"], "cy_t": [a["start"], a["end"]], "en_t": [b["start"], b["end"]],
                      "cy_sim": round(sim(a["text"], f["cy"]), 2), "en_sim": round(sim(b["text"], f["en"]), 2),
                      "cy_heard": a["text"], "en_heard": b["text"], "filled": True})
    # trim a Welsh clip whose chunk starts with other words (a header read without a pause)
    starts = {c["start"]: c for c in ch}
    for c in cards:
        chunk = starts.get(c["cy_t"][0])
        if not chunk or len(chunk["words"]) < 2 or c["cy_sim"] >= 0.8: continue
        ws = chunk["words"]
        best = max(range(len(ws)), key=lambda i: sim(" ".join(w["word"] for w in ws[i:]), c["cy"]))
        if best > 0: c["cy_t"][0] = round((ws[best-1]["end"] + ws[best]["start"]) / 2, 3)
    cards.sort(key=lambda c: c["cy_t"][0])
    missing = [{"unit": unit, "entry": f["entry"], "missing": True, "cy": f["cy"], "en": f["en"]} for i, f in enumerate(fs) if i not in used_f]
    return cards + missing

if __name__ == "__main__":
    unit, mp3, wj, vj, out = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
    book = json.load(open(vj)); cards = unit_cards(unit, mp3, wj, book["vocab"] if isinstance(book, dict) else book)
    json.dump(cards, open(out, "w"), ensure_ascii=False, indent=0)
    for c in cards:
        if c.get("missing"): print("MISSING", c["cy"], "/", c["en"]); continue
        flag = "  <<" if min(c["cy_sim"], c["en_sim"]) < 0.4 else ""
        print(f'{c["cy_t"][0]:7.1f} {c["cy"]:22} {c["cy_sim"]:.2f} [{c["cy_heard"]}] | {c["en"]:18} {c["en_sim"]:.2f} [{c["en_heard"]}]{flag}')
