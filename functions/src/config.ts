import { defineSecret, defineString } from "firebase-functions/params";

export const REGION = "europe-west2";

/** ElevenLabs API key. Set with: firebase functions:secrets:set ELEVENLABS_API_KEY */
export const elevenLabsApiKey = defineSecret("ELEVENLABS_API_KEY");

/** Comma-separated list of Google account emails allowed to use the app. */
export const allowedEmails = defineString("ALLOWED_EMAILS", {
  default: "austin.leirvik@gmail.com",
  description: "Comma-separated emails allowed to call functions",
});

/** ElevenLabs speech-to-text model. */
export const scribeModelId = defineString("SCRIBE_MODEL_ID", {
  default: "scribe_v1",
  description: "ElevenLabs speech-to-text model id",
});

/** Anthropic API key for study materials. Set with: firebase functions:secrets:set ANTHROPIC_API_KEY */
export const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

/** Claude model that writes translations and study notes. */
export const claudeModelId = defineString("CLAUDE_MODEL_ID", {
  default: "claude-opus-5-5",
  description: "Claude model id for translations and study notes",
});

/** ElevenLabs voice that reads English translations. */
export const englishVoiceId = defineString("ENGLISH_VOICE_ID", {
  default: "JBFqnCBsd6RMkjVDRZzb",
  description: "ElevenLabs voice id for English translation audio",
});

/** ElevenLabs text-to-speech model for English translation audio. */
export const ttsModelId = defineString("TTS_MODEL_ID", {
  default: "eleven_flash_v2_5",
  description: "ElevenLabs text-to-speech model id",
});
