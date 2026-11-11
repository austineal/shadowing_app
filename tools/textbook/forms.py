"""Singular/plural forms of a book vocab entry: 'problem(au)' -> ('problem', 'problemau')."""
import re

def _plural(word, suffix):
    if suffix.startswith("-"):
        suffix = suffix[1:]
        i = word.rfind(suffix[0])
        return (word[:i] if i > 0 else word) + suffix
    return suffix

def split_forms(s):
    """'car (ceir)' -> ('car','ceir'); 'problem(au)' -> ('problem','problemau'); 'canolfan(nau) hamdden'."""
    s = s.strip()
    m = re.match(r"^(.*?)\s*\(([^)]+)\)\s*(.*)$", s)
    if not m: return s, None
    head, par, tail = m.groups()
    attached = not re.search(r"\s\($", s[: m.start(2)])  # '(' directly after the word
    if "," in head or "/" in par or "," in par:
        return s, None
    if attached:  # suffix: problem(au)
        sg = head
        pl = (head + par) if not par.startswith("-") else _plural(head, par)
    else:  # separate word: car (ceir), siaradwr (-wyr)
        sg, pl = head, (_plural(head, par) if par.startswith("-") else par)
    tail = (" " + tail) if tail else ""
    return sg + tail, pl + tail

def split_en(s):
    """'problem(s)' -> ('problem','problems'); 'party (parties)'; 'kind(s), type(s)'."""
    if "(" not in s: return s, None
    m = re.match(r"^(\S+) \((\S+)\)$", s)
    if m: return m[1], m[2]
    sg = re.sub(r"\s*\([^)]*\)", "", s)
    pl = re.sub(r"\(([^)]*)\)", r"\1", s)
    return sg, pl

if __name__ == "__main__":
    for t in ["problem(au)", "car (ceir)", "siaradwr (-wyr)", "canolfan(nau) hamdden", "ffôn (ffonau) symudol", "rhyw (rhai)", "cwpwrdd (cypyrddau)", "Pasg, y", "nos"]:
        print(t, split_forms(t))
    for t in ["problem(s)", "party (parties)", "kind(s), type(s)", "mobile phone(s)", "class(es)", "night"]:
        print(t, split_en(t))
