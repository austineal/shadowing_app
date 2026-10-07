"""Spans of a unit's audio holding dialogues (after 'Listen to the sgwrs') and Robin Radio pieces."""
import re, sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chunks import chunks

EN = set("the you are is do does what where how who listen to a i don't for translate and of in your practise practice let's lets out it this that with can be on when why will have has here there these those questions answer about episode tips top used one person know well child pet formal singular plural".split())
SGWRS = re.compile(r"\b(s?g?wrs|skurs|sgyrs|sgwr|gwrs|s?cwrs)\b", re.I)
RADIO = re.compile(r"robin\s*radio", re.I)
STOP = re.compile(r"beth am (y ?m)?arfer|let'?s practi|listen|gwrandewch|grandewch|robin\s*radio|help llaw|top tips|darllenwch|read the", re.I)

def english(t):
    ws = re.findall(r"[a-z']+", t.lower())
    return bool(ws) and sum(w in EN for w in ws) / len(ws) >= 0.4

def spans(ch):
    out, i = [], 0
    while i < len(ch):
        t = ch[i]["text"]
        if RADIO.search(t):
            j = i + 1
            while j < len(ch) and not (re.search(r"help llaw|top tips|listen to|sgwrs", ch[j]["text"], re.I)) and ch[j]["start"] - ch[j-1]["end"] < 15: j += 1
            # the piece starts after the last English line (questions, translate prompts) before its end
            k = max([x for x in range(i, j) if english(ch[x]["text"])], default=i)
            if j > k + 1: out.append(("radio", ch[k+1]["start"], ch[j-1]["end"]))
            i = j; continue
        if SGWRS.search(t) and (english(t) or re.search(r"wrandewch|grandewch|gwrandewch", t, re.I)):
            j = i + 1
            while j < len(ch) and (SGWRS.search(ch[j]["text"]) or english(ch[j]["text"])) and ch[j]["start"] - ch[j-1]["end"] < 3: j += 1
            k = j
            while k < len(ch) and not STOP.search(ch[k]["text"]) and not (english(ch[k]["text"]) and k+1 < len(ch) and english(ch[k+1]["text"])) and ch[k]["start"] - ch[k-1]["end"] < 6: k += 1
            if k > j: out.append(("sgwrs", ch[j]["start"], ch[k-1]["end"]))
            i = k; continue
        i += 1
    return out

if __name__ == "__main__":
    ch = chunks(sys.argv[1], sys.argv[2])
    for kind, a, b in spans(ch):
        inside = [c["text"] for c in ch if a <= c["start"] and c["end"] <= b]
        print(f"{kind:6} {a:7.1f}-{b:7.1f} ({b-a:5.1f}s)  {' / '.join(inside)[:300]}")
