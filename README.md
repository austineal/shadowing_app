# Shadowing

A single-user progressive web app for practising **shadowing**: listening to a
podcast phrase by phrase and repeating each phrase aloud. Runs in the browser on
desktop and installs to the Android home screen from Chrome.

- Import audio by uploading a file or picking an episode from a podcast RSS feed.
- Audio is transcribed with word timestamps by ElevenLabs speech-to-text, or, if
  you supply a transcript, that transcript is aligned to the recognised speech so
  your wording inherits the timestamps.
- The transcript is cut into phrases (sentence punctuation, pauses, configurable
  maximum length). Play each phrase, repeat it, loop it, or auto-advance with a
  pause sized to the phrase for you to speak in.
- Split and merge phrases by hand. Position, settings and edits are saved.

## Layout

| Path | What |
|---|---|
| `web/` | Vite + React + TypeScript PWA (`src/pages`, `src/hooks`, `src/lib`) |
| `web/src/lib/segmenter.ts` | Phrase segmentation from timed tokens |
| `web/src/lib/align.ts` | Aligns a user transcript to speech-recognition words |
| `functions/` | Cloud Functions (Node 22, europe-west2): transcription trigger, RSS import, retry |
| `firestore.rules`, `storage.rules` | Owner-only access, allow-listed by email |

Data model (Firestore): `users/{uid}/episodes/{id}` holds episode metadata and
status; `users/{uid}/episodes/{id}/data/segments` holds the phrase list. Storage
holds `audio.<ext>`, `words.json` (ElevenLabs response), optional
`transcript.txt` and `aligned.json` under the same prefix.

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
5. **Deploy everything:**
   ```bash
   npm run deploy
   ```
   The app is then served at https://shadowing-practice-app.web.app. Open it in
   Chrome on Android and choose *Install app* / *Add to Home screen*.

Optional: if you later want offline audio caching, apply `cors.json` to the
bucket (`gcloud storage buckets update gs://shadowing-practice-app.firebasestorage.app --cors-file=cors.json`).

## Development

```bash
npm install --prefix web && npm install --prefix functions
npm run dev          # Vite dev server on http://localhost:5173 (talks to the live Firebase project)
npm test             # unit tests for segmenter and aligner
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
