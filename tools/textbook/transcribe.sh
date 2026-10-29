#!/bin/sh
# Whole-file Welsh transcription with word timings for each unit's audio, then a second pass over the
# speech chunks the first pass left empty. Needs mlx_whisper (Homebrew python) and ffmpeg.
#   transcribe.sh <out dir> <unit mp3>...
set -e
out=$1; shift
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
for f in "$@"; do
  json="$out/$(basename "${f%.*}").json"
  [ -s "$json" ] || mlx_whisper "$f" --model mlx-community/whisper-large-v3-turbo --language cy --output-format json \
    --output-dir "$out" --verbose False --condition-on-previous-text False --word-timestamps True >/dev/null 2>&1
  fill="${json%.json}.fill.json"
  [ -s "$fill" ] || /opt/homebrew/opt/python@3.14/bin/python3.14 -I "$here/fill_empty.py" "$f" "$json" "$fill"
  echo "transcribed $f"
done
