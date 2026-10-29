"""Spans of a unit's audio holding dialogues (after 'Listen to the sgwrs') and Robin Radio pieces."""
import re, sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chunks import chunks

EN = set("the you are is do does what where how who listen to a i or child pet work well know person good morning afternoon evening night greetings don't for translate and of in your practise practice let's lets out it this that with can be on when why will have has here there these those questions answer about episode tips top used one person know well child pet formal singular plural".split())
SGWRS = re.compile(r"\b(y?s?[gck]?[wu]rs|sgyrs|sgwr|dd?eialog)\b", re.I)  # Whisper spells "sgwrs" many ways
RADIO = re.compile(r"^\W*robin\s*radio", re.I)  # at the start of a chunk: not "as heard in Robin Radio"
BARE_RADIO = re.compile(r"^\W*radio\W*$", re.I)
TRANSLATE = re.compile(r"^\W*(c\w{0,3}eithwch|translate)\b", re.I)  # Whisper: Cyddeithwch, Cefieithwch
STOP = re.compile(r"^\W*y ?m?arfer\b|cwestiynau|yes and no|revision|\br\w{0,3}\s?d?\s?ewch\b|atebwch|pwyslais|ynganu|beth am (y ?m)?arfer|let'?s practi|listen|gwrandewch|grandewch|^\W*robin\s*radio|help llaw|^help\b|top tips|darllenwch|read the", re.I)

DICT = set(w.strip().lower() for w in open("/usr/share/dict/words"))  # macOS word list
# Welsh words that are also in the word list
WELSH = set("hello faint car plant man hen pen ham gem tal sir ward bore nos dim a i o y e ar am ac at na ni fi hi ti chi fe dim da mae yn bore te oer pen tri un dau pump wyth naw deg".split())

def english(t):
    """Instruction-style English (strict: dialogues themselves mix in 'hello', 'please')."""
    ws = re.findall(r"[a-z']+", t.lower())
    hits = [w for w in ws if w in EN]
    if not set(hits) - {"a", "i"}: return False  # 'a' and 'i' are Welsh words too
    return len(hits) / len(ws) >= 0.4

def prompt(t):
    """Any English sentence, e.g. the radio piece's 'Translate' prompts."""
    ws = [w.split("'")[0] for w in re.findall(r"[a-z']+", t.lower())]
    ws = [w for w in ws if w]
    if not ws: return False
    hits = [w for w in ws if w in EN or (len(w) >= 3 and w in DICT)]
    if not set(hits) - WELSH and not re.search(r"\bi'(m|d|ll|ve)\b", t.lower()): return False
    return len(hits) / len(ws) >= 0.5  # names: "I'm Haf."

def spans(ch):
    out, i = [], 0
    while i < len(ch):
        t = ch[i]["text"]
        if TRANSLATE.match(t) and len(t) < 30:
            # a Robin Radio piece: questions, phrases to listen for, then 'Cyfieithwch / Translate' and three
            # English prompts; the piece follows them (or starts at a long chunk, where Whisper merged a prompt in)
            s0, n = i + 1, 0
            while s0 < len(ch) and TRANSLATE.match(ch[s0]["text"]) and len(ch[s0]["text"]) < 30: s0 += 1
            while s0 < len(ch) and n < 3 and ch[s0]["end"] - ch[s0]["start"] < 6:
                n += ch[s0]["end"] - ch[s0]["start"] >= 0.3
                s0 += 1
            e = s0
            while e < len(ch) and (e == s0 or not STOP.search(ch[e]["text"])) and not (english(ch[e]["text"]) and e + 1 < len(ch) and english(ch[e+1]["text"])) \
                    and (e == s0 or ch[e]["start"] - ch[e-1]["end"] < 15):
                e += 1
            if e > s0 and ch[e-1]["end"] - ch[s0]["start"] >= 10: out.append(("radio", ch[s0]["start"], ch[e-1]["end"]))
            i = max(e, i + 1); continue
        if SGWRS.search(t) and not re.search(r"wrth\s+gwrs", t, re.I) and re.search(r"listen|wch\b|\bar y", t, re.I):
            j = i + 1
            while j < len(ch) and (SGWRS.search(ch[j]["text"]) or english(ch[j]["text"])) and ch[j]["start"] - ch[j-1]["end"] < 3: j += 1
            k = j
            while k < len(ch) and not STOP.search(ch[k]["text"]) and not RADIO.search(ch[k]["text"]) and not BARE_RADIO.search(ch[k]["text"]) and not TRANSLATE.match(ch[k]["text"]) and not (SGWRS.search(ch[k]["text"]) and re.search(r"wch\b|\bar y", ch[k]["text"], re.I)) and not (english(ch[k]["text"]) and k+1 < len(ch) and english(ch[k+1]["text"])) and ch[k]["start"] - ch[k-1]["end"] < 6: k += 1
            if k > j: out.append(("sgwrs", ch[j]["start"], ch[k-1]["end"]))
            i = k; continue
        i += 1
    return out

if __name__ == "__main__":
    ch = chunks(sys.argv[1], sys.argv[2])
    for kind, a, b in spans(ch):
        inside = [c["text"] for c in ch if a <= c["start"] and c["end"] <= b]
        print(f"{kind:6} {a:7.1f}-{b:7.1f} ({b-a:5.1f}s)  {' / '.join(inside)[:300]}")
