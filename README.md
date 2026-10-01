# Shadowing

A single-user progressive web app for practising **shadowing**: listening to a
podcast phrase by phrase and repeating each phrase aloud. Runs in the browser on
desktop and installs to the Android home screen from Chrome.

- Import audio by uploading a file or picking an episode from a podcast RSS feed.
- Variable-bitrate MP3s are re-encoded at a constant 128 kbps before transcription.
  Browsers seek in VBR MP3s using a coarse table that can land tens of seconds from
  the requested time, so phrases would play the wrong audio; CBR seeks are exact.
- Audio is transcribed with word timestamps by ElevenLabs speech-to-text, or, if
  you supply a transcript, that transcript is aligned to the recognised speech so
  your wording inherits the timestamps.
- The transcript is cut into phrases (sentence punctuation, pauses, configurable
  maximum length). Play each phrase, repeat it, loop it, or auto-advance with a
  pause sized to the phrase for you to speak in.
- Split and merge phrases by hand. Position, settings and edits are saved.
- The library groups episodes by language, then folder or podcast. Long groups show ten
  episodes at a time, the search button finds episodes by title, podcast, folder or
  language, and coming back from an episode returns to the same place in the list.

## Layout

| Path | What |
|---|---|
| `web/` | Vite + React + TypeScript PWA (`src/pages`, `src/hooks`, `src/lib`) |
| `web/src/lib/segmenter.ts` | Phrase segmentation from timed tokens |
| `web/src/lib/align.ts` | Aligns a user transcript to speech-recognition words |
| `web/src/lib/drill/` | Drill: passages, review schedule, session cadence, session plan and steps |
| `functions/` | Cloud Functions (Node 22, europe-west2): transcription trigger, RSS import, retry |
| `firestore.rules`, `storage.rules` | Owner-only access, allow-listed by email |

Data model (Firestore): `users/{uid}/episodes/{id}` holds episode metadata and
status; `users/{uid}/episodes/{id}/data/segments` holds the phrase list. Storage
holds `audio.<ext>`, `words.json` (ElevenLabs response), optional
`transcript.txt` and `aligned.json` under the same prefix.

Study mode (translations, notes, English audio) is stored per phrase *text*, not
per segment, so it survives splits and merges: `users/{uid}/phrases/{key}`, where
`key` hashes the language and normalised text (`phraseKey` in
`functions/src/study.ts` and `web/src/lib/study.ts`, which must stay in sync). Each
phrase doc lists the `episodeIds` that use it. The learner's level per language
is in `users/{uid}/prefs/study`. English translation audio is generated on the
device with Piper voices (`web/src/lib/piper`, `web/src/lib/tts`); voice models
are downloaded once into Cache Storage.

## One-time setup

The Firebase project `shadowing-practice-app` already exists with a Firestore
database in `europe-west2`, and the Firestore rules are deployed. The remaining
steps need the Firebase console or your own credentials:

1. **Upgrade to the Blaze (pay-as-you-go) plan.** Required for Cloud Storage,
   Cloud Functions and for functions to call the ElevenLabs API.
   https://console.firebase.google.com/project/shadowing-practice-app/usage/details
2. **Create the default Storage bucket** in *Build → Storage → Get started*.
   Choose location **europe-west2 (London)** to match Firestore and the functions.
   Then deploy the rules: `npm run deploy:rules`.
3. **Enable Google sign-in** in *Build → Authentication → Sign-in method → Google*.
   Sign in with the account listed in `firestore.rules`, `storage.rules` and the
   `ALLOWED_EMAILS` parameter. To allow another account, add it in all three places.
4. **Store the ElevenLabs API key** as a secret (you type it, it never enters the repo):
   ```bash
   firebase functions:secrets:set ELEVENLABS_API_KEY
   ```
   Study mode also needs an Anthropic API key:
   ```bash
   firebase functions:secrets:set ANTHROPIC_API_KEY
   ```
5. **Allow the browser to download from the bucket (CORS).** The Firebase SDK
   can upload without this, but reading `words.json` and transcripts from the
   browser fails with `storage/retry-limit-exceeded` until the bucket has a CORS
   policy. Needs the Google Cloud CLI once:
   ```bash
   brew install --cask gcloud-cli
   gcloud auth login
   gcloud storage buckets update gs://shadowing-practice-app.firebasestorage.app --cors-file=cors.json
   ```
   Add any extra origins you serve the app from to `cors.json` and re-run the last command.
6. **Deploy everything:**
   ```bash
   npm run deploy
   ```
   The app is then served at https://shadowing-practice-app.web.app. Open it in
   Chrome on Android and choose *Install app* / *Add to Home screen*.

## Offline use

The app shell is precached by a service worker, and Firestore keeps a local copy
of your episode list, phrases, settings and position, so anything you have
opened once works offline. Edits made offline sync when you reconnect.

Audio is not stored automatically because episodes are large. Tap **Save
offline** in an episode's ⋯ menu in the library, or in the practice settings
sheet, to download its audio and word timings to the device. Saved episodes show
**✓ Offline**; tap the button again to remove the copy. The library footer shows how much
device storage the app is using. Importing and transcribing always need a
connection.

Under the hood: the audio file is stored whole in a Cache Storage bucket named
`audio-files`, and the service worker answers the audio element's range requests
from it. Word-timing JSON lives in `episode-data` with a network-first policy.
Both require the bucket CORS policy from setup step 5.

## Background playback (screen off)

Practice keeps running with the phone locked or the app in the background. The
phrase audio is routed through Web Audio into a MediaStream that a second,
never-paused audio element plays, so the OS sees one continuous track even
during the silent gaps between phrases (iOS suspends JavaScript within seconds
of audio stopping; Android throttles background timers). Phrase ends and gaps
are timed on the audio clock rather than `setTimeout`. Lock-screen and headset
controls map to play/pause, next/previous phrase and repeat.

If the browser refuses to play the stream element, audio falls back to direct
output and background playback is best-effort only.

To test on a device: start auto mode, lock the phone, and leave it for at least
five minutes (Android's tab freezing kicks in after five minutes in the
background). Phrases and gaps should keep alternating, and the lock-screen
controls should skip and repeat phrases. Check with both a saved-offline episode
and a streamed one, since the service worker serves the former.

## Drill (spaced repetition)

Optional practice for learning to *say* an excerpt: you hear the English, say the
original, then hear it as the answer. Passive listening and study mode are
unaffected.

- **Choosing an excerpt.** Tap **Drill** on an episode, then tap the excerpt's first
  and last phrases, or tap **Suggest excerpts**: Claude (`suggestExcerpts`) splits the
  episode into self-contained sections rated for speaking practice, each about two
  weeks of new material long at that language's pace. The pace is estimated from the
  schedule until there are two weeks of sessions, then measured from them. Choosing an
  excerpt queues translations for just that stretch (`prepareDrillStudy`), without
  turning study mode on for the whole episode, and has Claude (`planDrillPassages`)
  split it into titled passages of about 40 seconds at natural breaks. Until that
  arrives, passages are cut at pauses and sentence ends. When every excerpt in a
  language is learned, the library links to the next suggestion in the same episode.
- **Sessions.** Each language has its own schedule (**Drill schedules** in the
  library): how often it comes up (up to three times a day, down to weekly), how long
  a session is, whether it learns new material, and a full or light learning drill.
  Languages on the same every-few-days rhythm take turns. The library's **Drills** box
  shows which are due. A session reviews due passages first (most overdue first, then
  in story order, each led in by the phrase before it), then learns new passages of the
  current excerpt with the time left, stopping partway through a passage if need be
  and resuming next time. The session clock counts only time spent playing.
- **Learning** a phrase: its English, listen and repeat, a first try from the English,
  then joined to the phrase before. A passage finishes with every phrase from its
  English and a straight run-through to shadow.
- **Reviews and grading.** Each cue is tested cold: English, a pause to say it
  (shorter as the passage matures), then the original. Cues grow as a passage
  matures: a phrase at a time at first, whole sentences from level 2 (a three-day
  gap; a sentence over 15 seconds is cued in parts), and runs of sentences of up to
  20 seconds from level 4 (two weeks; a pause of over a second ends a run). Press
  **Missed** (or ⏮ on the lock screen or headset) if you couldn't; that jumps to the
  answer and adds a fix-up round (for a cue of several phrases, each phrase heard and
  repeated once, then the whole cue again). A passage passes with at most one missed
  cue (none if it has three cues or fewer) and moves up a level (next review after 1,
  3, 7, 15, 30, 60, 120, then 240 days); a fail moves it down one. Passing after a
  longer gap than planned moves it up to the level that gap matches.
- **Load ahead.** **Drill schedules** shows each language's reviews over the next two
  weeks, if they all go well, against the time its sessions have (estimated from each
  passage's audio length). A session only starts a new passage if that passage's
  reviews (at the next session, a day later, then three days after that) would still
  fit in the coming week's sessions; otherwise the session screen says which day is
  full and offers **Learn one anyway**. A review whose next gap is a week or more can
  move by about a tenth of the gap to the lightest nearby day, but only when its
  planned day would otherwise have more than about half its session time in reviews,
  so neighbouring passages usually keep coming up together.
- **Coverage.** The library marks each episode with drill excerpts with how much of it they
  cover ("5% in drills"), or "All in drills" once what's left outside them is no more
  than an intro's worth (5 seconds or 5% of the episode).
- **Progress map.** The library's **Drills** box and **Drill schedules** show each
  excerpt as a strip of its passages: being learned, just learned (level 0–1),
  growing (2–3) or solid (4 and up: still known after a week away), with due ones
  underlined. In the episode's transcript the excerpt's phrases are coloured the same
  way, each passage is headed by its title and stage, and a line marks how far it's
  learned.
- **Screen off.** The English is synthesised on the device before a session starts,
  and the session plays through the same background graph as practice. A chime and a
  few words in the English voice announce each change of activity, so a session can be
  followed without the screen: each passage's start ("Review: …", "New passage: …" or
  "Continuing: …", with the passage's title), the run-through of a newly learned
  passage, shadowing, and the end of the session. The chime sets these apart from the
  English cues.
- **English clips are kept** in Cache Storage (`tts-clips`, 16-bit audio) and made
  ahead while the library is open: each scheduled language's next session is planned
  and any English not yet stored is synthesised, so sessions start at once and work
  offline. This stops when you leave the library, so it never delays English you need
  right away. Clips unused for 60 days are deleted, and so are the least recently
  used once the store passes 150 MB; they're made again when needed. Drills have their
  own English voice, and **Drill schedules** shows how much space the clips take, with
  a Clear button.

Data: `users/{uid}/drills/{id}` holds an excerpt and its passages (time ranges, so
phrase edits don't orphan them, with each passage's level and due date);
`users/{uid}/prefs/drill` the schedules; `users/{uid}/drillSessions/{id}` a log of
sessions, which the schedules count only once a session has finished something, and
which record the audio learned for measuring pace. An episode's suggested excerpts
are at `users/{uid}/episodes/{id}/data/excerpts`.

## Development

```bash
npm install --prefix web && npm install --prefix functions
npm run dev          # Vite dev server on http://localhost:5173 (talks to the live Firebase project)
npm test             # unit tests (segmenter, aligner, player steps, drill scheduling)
npm run typecheck
```

Function parameters can be changed at deploy time or in `functions/.env`:
`SCRIBE_MODEL_ID` (default `scribe_v1`) and `ALLOWED_EMAILS`.

## Notes on languages

Language codes sent to ElevenLabs live in `web/src/lib/languages.ts`. Japanese
and Chinese are marked `charBased`, which switches transcript alignment and
phrase merging to character mode. Norwegian offers Bokmål (`no`) and Nynorsk
(`nn`); if ElevenLabs rejects a code, the episode shows an error with the API
message and *Retry transcription* re-runs it after you change the entry.
