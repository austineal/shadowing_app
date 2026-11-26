# Course book → shadowing material

Mines a Dysgu Cymraeg course book (PDF) and its per-unit audio for the shadowing app:

| Output | What | Import as |
|---|---|---|
| `Geirfa Unedau a-b/` | Vocab cards: Welsh clip + English clip cut from the recording; text shows gender, `nos (f)`, `ceir (m pl)` | Deck (`geirfa.csv` + its clips) |
| `Ymadroddion Unedau a-b/` | Pattern sentences found in the audio, with the book's English (and English audio when the recording reads it) | Deck (`ymadroddion.csv` + its clips) |
| `Sgyrsiau Unedau a-b.mp3` | Every dialogue (after "Listen to the sgwrs") and Robin Radio piece, joined | Episode, no transcript (the app transcribes it) |

Built for *Mynediad (De)*, Fersiwn 2. Later books in the series probably share its layout; check the
assumptions below on a page or two before trusting a run.

## Steps

```sh
python3 -m venv ~/.venvs/textbook && ~/.venvs/textbook/bin/pip install pymupdf   # once
cd tools/textbook
unzip -d /tmp/book-audio "<audio>.zip"
~/.venvs/textbook/bin/python book.py "<book>.pdf" /tmp/book.json            # vocab + sentence pairs
./transcribe.sh /tmp/book-tx /tmp/book-audio/*Uned*.mp3                       # ~1-2 min per unit
python3 build.py analyse /tmp/book.json "/tmp/book-audio/... Uned {n} - 2021.mp3" /tmp/book-tx "<out>" --units 1-28
# read <out>/review.txt, spot-check a few clips
python3 build.py cut ...same arguments...
```

`book.py` needs pymupdf (the venv); the rest uses the system python, `transcribe.sh` uses Homebrew's
`mlx_whisper` and its python, and everything uses `ffmpeg`.

## Layout assumptions (check these for a new book)

- **Unit**: from each page's footer, `Uned N / <level>`.
- **Geirfa pages**: a `Geirfa` heading, then coloured boxes: red `ee3124` feminine, blue `00aeef` masculine,
  black verbs, green `3ab54a` adjectives, purple `46166b`/`522a74` other (`CAT` in `book.py`). Welsh is
  AktivGrotesk-Bold, English thin/light italic on the same line. Plurals as `problem(au)`, `car (ceir)`,
  `siaradwr (-wyr)` (`forms.py`). Pages with fewer than 5 entries are ignored, which skips the glossary.
- **Sentence pairs**: bold (or light) Welsh with italic English ≥100 pt to the right on the same line. Noise is
  fine: a pair only becomes a card if its Welsh is found in the audio.
- **Audio**: one MP3 per unit. Vocab read as Welsh, English (singular, then plural), with ~1 s pauses.
  Dialogues come after "Listen to the sgwrs / Gwrandewch ar y sgwrs"; Robin Radio after its questions.

## How the alignment works, and what was learned

- Speech is split at pauses (`ffmpeg silencedetect`, -35 dB, 0.35 s): those are the clip boundaries.
  Whisper only supplies text to recognise the chunks.
- Whole-file Whisper with `--language cy --condition-on-previous-text False --word-timestamps True` is good;
  without the condition flag it loops ("ll, ll, ll" for minutes). It still returns nothing for some
  stretches, so `fill_empty.py` re-transcribes just those chunks. Transcribing every chunk separately is
  ~10× slower and worse for short Welsh words.
- Vocab: the audio doesn't always follow the book's order, so cards are best (Welsh chunk, English chunk)
  pairs inside the vocab section, then gaps between matched neighbours are filled by position.
- Sentences: the book drills minimal pairs (*Dw i'n lico coffi* / *Dw i ddim yn lico coffi*), so a match needs
  every book word of 4+ letters heard and few extra words, on top of character similarity.
- The app aligns a supplied transcript by diffing it against recognised speech, so a transcript covering only
  part of the audio leaves the rest without phrases. That's why dialogue episodes go in without one.
- Uploading a deck adds it to the drills straight away, so decks are split by `--part` units.
