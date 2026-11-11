"""Reads a Dysgu Cymraeg course book PDF: unit vocab (Geirfa, category from colour) and Welsh/English sentence pairs.

usage: book.py <book.pdf> <out.json>   (needs pymupdf)
Writes {"vocab": [{unit, cat, cy, en}], "pairs": [{unit, page, cy, en}]}; unit is None before the first unit.
"""
import json, re, sys
import pymupdf

# Geirfa colours: red feminine nouns, blue masculine nouns, black verbs, green adjectives, purple other.
CAT = {"ee3124": "f", "f04d30": "f", "00aeef": "m", "000000": "verb", "3ab54a": "adj", "46166b": "other", "522a74": "other"}
LEGEND = {"feminine nouns", "masculine nouns", "verbs", "adjectives", "other", "masculine nouns verbs adjectives other"}
FOOTER = re.compile(r"^Uned\s+(\S+)\s*/\s*\S+")
clean = lambda t: re.sub(r"\s+", " ", t).strip()
color = lambda s: f'{s["color"]:06x}'

def page_spans(page):
    return [s for b in page.get_text("dict")["blocks"] for l in b.get("lines", []) for s in l["spans"] if clean(s["text"])]

def page_unit(spans, last):
    for s in spans:
        m = FOOTER.match(clean(s["text"]))
        if m: return int(m[1]) if m[1].isdigit() else m[1]
    return last

def vocab(spans, unit):
    """Entries in reading order: colour box, then column, then row. Wrapped lines are joined."""
    top = min((s["bbox"][1] for s in spans if clean(s["text"]) == "Geirfa"), default=None)
    if top is None: return []
    bottom = min((s["bbox"][1] for s in spans if "Geiriau pwysig" in s["text"]), default=1e9)
    vs = [s for s in spans if top < s["bbox"][1] < bottom and color(s) in CAT and s["font"].startswith("AktivGrotesk")
          and s["font"] != "AktivGrotesk-Medium" and not s["font"].endswith("Light")]
    rows = {}
    for s in vs:
        x, y = s["bbox"][0], round(s["bbox"][1])
        key = (CAT[color(s)], 0 if x < 250 else 1, y)
        k = next((k for k in rows if k[:2] == key[:2] and abs(k[2] - y) <= 3), key)
        r = rows.setdefault(k, {"cy": "", "en": ""})
        kind = "cy" if "Bold" in s["font"] else "en"
        r[kind] = clean(r[kind] + " " + s["text"])
    rows = {k: r for k, r in rows.items() if r["cy"] or r["en"] not in LEGEND}
    # English printed in another colour than its Welsh (e.g. purple 'mewn', black 'in a'): join by line
    for k, r in list(rows.items()):
        if r["cy"] or k not in rows: continue
        host = next((h for h, hr in rows.items() if h != k and h[1] == k[1] and abs(h[2] - k[2]) <= 3 and hr["cy"] and not hr["en"]), None)
        if host: rows[host]["en"] = r["en"]; del rows[k]
    first = {}
    for (cat, _, y), r in rows.items():
        if r["cy"] and r["en"]: first[cat] = min(first.get(cat, 1e9), y)
    entries = []
    for (cat, col, y), r in sorted(rows.items(), key=lambda kv: (first.get(kv[0][0], 1e9), kv[0][1], kv[0][2])):
        prev = entries[-1] if entries else None
        if prev and prev["cat"] == cat and prev["col"] == col and y - prev["y"] < 22 and (not r["en"] or not r["cy"]):
            prev["cy"] = clean(prev["cy"] + " " + r["cy"]); prev["en"] = clean(prev["en"] + " " + r["en"]); prev["y"] = y
            continue
        entries.append({"unit": unit, "cat": cat, "col": col, "y": y, **r})
    for e in entries: e.pop("col"); e.pop("y")
    out = [e for e in entries if e["cy"] and e["en"]]
    if len(out) < 5: return []  # not a unit vocab page (e.g. the glossary)
    for e in entries:
        if not (e["cy"] and e["en"]): print("incomplete vocab entry, skipped:", e, file=sys.stderr)
    return out

def pairs(spans, unit, pno):
    """Bold (or light) Welsh with thin-italic English further right on the same line."""
    rows, out = {}, []
    for s in spans:
        y = round(s["bbox"][1])
        rows.setdefault(next((k for k in rows if abs(k - y) <= 3), y), []).append(s)
    for ss in rows.values():
        ss.sort(key=lambda s: s["bbox"][0])
        cy = [s for s in ss if ("Bold" in s["font"] or s["font"].endswith("Light")) and "Grotesk" in s["font"] and "Ital" not in s["font"]]
        en = [s for s in ss if "ThinItal" in s["font"] or s["font"].endswith("LightItalic")]
        if not cy or not en or en[0]["bbox"][0] - cy[0]["bbox"][0] < 100: continue
        cyt = clean(" ".join(s["text"] for s in ss if s["bbox"][0] < en[0]["bbox"][0] and "Grotesk" in s["font"] and "Thin" not in s["font"]))
        ent = clean(" ".join(s["text"] for s in en))
        if len(cyt) < 3 or re.fullmatch(r"[A-Z]?:|\d+\.?", cyt) or ":" in cyt[:4]: continue
        out.append({"unit": unit, "page": pno, "cy": cyt, "en": ent})
    return out

if __name__ == "__main__":
    d = pymupdf.open(sys.argv[1])
    res, unit = {"vocab": [], "pairs": []}, None
    for i, page in enumerate(d):
        spans = page_spans(page)
        unit = page_unit(spans, unit)
        v = vocab(spans, unit)
        if v: res["vocab"] += v
        else: res["pairs"] += pairs(spans, unit if isinstance(unit, int) else None, i + 1)
    json.dump(res, open(sys.argv[2], "w"), ensure_ascii=False, indent=0)
    from collections import Counter
    print("vocab", len(res["vocab"]), dict(Counter(e["unit"] for e in res["vocab"])))
    print("pairs", len(res["pairs"]))
