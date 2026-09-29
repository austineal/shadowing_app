import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "Shadowing",
        short_name: "Shadowing",
        description: "Phrase-by-phrase shadowing practice for podcasts in foreign languages",
        theme_color: "#0f1115",
        background_color: "#0f1115",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallbackDenylist: [/^\/__\//],
        runtimeCaching: [
          {
            // Episode audio (Firebase Storage download URLs). Full files are put in this cache by
            // the app's "Save offline" action; the range-requests plugin then serves the <audio>
            // element's partial requests from it. Only complete (200) responses are ever stored, so
            // ordinary streaming (206 responses) never pollutes the cache.
            urlPattern: /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/.*%2Faudio\.[A-Za-z0-9]+\?alt=media/,
            handler: "CacheFirst",
            options: {
              cacheName: "audio-files",
              rangeRequests: true,
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // On-device TTS runtime (onnxruntime-web and the Piper phonemiser with its espeak-ng
            // data), loaded from the CDN by the TTS worker. Versioned URLs, so cache-first is safe
            // and makes English audio work offline after first use. Voice models are cached by the
            // app itself (lib/piper/runner.ts).
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/(onnxruntime-web@|@diffusionstudio\/piper-wasm@)/,
            handler: "CacheFirst",
            options: {
              cacheName: "tts-runtime",
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Word timings (words.json / aligned.json) read via the Storage SDK. Fresh when online,
            // cached copy when not.
            urlPattern: /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/.*%2F(words|aligned)\.json\?alt=media/,
            handler: "NetworkFirst",
            options: {
              cacheName: "episode-data",
              networkTimeoutSeconds: 5,
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  server: { port: 5173 },
});
