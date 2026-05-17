<p align="center">
  <img src="extension/icons/icon512.png" alt="Polyglot" width="120" />
</p>

# Polyglot

**Real-time translation of any browser tab's audio.** Speak English on a livestream, hear it in Spanish (or 10+ other languages) within ~1–2 seconds, in a voice that matches the speaker. Captions in a side panel.

Two parts: a Chrome extension that captures tab audio, and a Python WebSocket server that handles ASR → translation → TTS.

> **Status:** working prototype. Headed for [BYOK](#byok-direction) (bring-your-own-key) so it can ship without backend hosting.

## Layout

```
extension/    Chrome Manifest V3 extension — side panel UI, offscreen
              audio capture, WebSocket client
server/       Python streaming backend — FastAPI WebSocket, Deepgram
              ASR, Google Translate, ElevenLabs TTS, optional ECAPA-TDNN
              speaker clustering
server/tests/ Unit tests for the streaming pipeline
```

## Pipeline

```
tab audio ──► extension (PCM16 @ 16kHz, 200ms frames)
          ──► ws://server/ws/translate
          ──► Deepgram Nova-3 (streaming ASR + diarization)
          ──► ECAPA-TDNN speaker clustering (corrects same-speaker collapse)
          ──► Google Translate
          ──► ElevenLabs Flash v2.5 (streaming TTS)
          ──► MP3 chunks back to extension ──► gapless playback in offscreen doc
```

Sync: video is paused for ~30s while audio buffers, then video seeks back and playback resumes. Drift is corrected via small playback-rate adjustments. See `extension/BUGS.md` for the long form of how the sync was hardened.

## Getting API keys

You need three accounts. Free tiers cover plenty of testing.

| Service | Used for | Sign up | Free tier |
|---|---|---|---|
| **Deepgram** | Streaming ASR + speaker diarization | https://console.deepgram.com/signup | $200 in credit, no card |
| **ElevenLabs** | Streaming TTS (voice cloning) | https://elevenlabs.io/sign-up | 10k chars/month |
| **Google Cloud Translate** | Text translation | https://console.cloud.google.com/ | $10/month free up to 500k chars |

For Google Translate specifically:
1. Create or pick a Google Cloud project.
2. Enable the **Cloud Translation API** ([direct link](https://console.cloud.google.com/apis/library/translate.googleapis.com)).
3. Create a service account → add the **Cloud Translation API User** role → create a JSON key → download.
4. Save the file (e.g. as `google_keys.json` outside the repo) and point `GOOGLE_APPLICATION_CREDENTIALS` at its absolute path.

## Run locally

### 1. Backend

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements_streaming.txt

# fill in keys
cp ../.env.example ../.env
$EDITOR ../.env

python run_streaming.py    # serves ws://localhost:8765/ws/translate
```

### 2. Extension

```bash
cd extension
npm install
```

Then in Chrome:
1. Visit `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` directory
4. Click the extension icon to open the side panel
5. Visit a tab with audio (YouTube, Twitch, etc.), pick a target language, hit **Start**

The extension is currently hardcoded to `ws://localhost:8765` (see `extension/offscreen/offscreen.js`).

## Tests

```bash
# Backend (79 tests)
cd server && pytest tests/ -q

# Extension (403 tests)
cd extension && npm test
```

## BYOK direction

Today, API keys live on the server in `.env`. For a true BYOK shipped extension we'll need one of:

1. **Backend stays, user keys flow through WS handshake.** Still needs hosting; "BYOK" only in the sense that users supply keys.
2. **Drop the backend entirely.** Extension calls Deepgram + ElevenLabs + a translation API directly using user-supplied keys. Real BYOK, zero infra. Loses the PyTorch-based speaker clustering in `server/speaker_embedder.py` (browser can't run the ECAPA-TDNN model).

Decision pending.

## Origin

Imported from [sport-translations](https://github.com/mollysandler/sport-translations), which remains the working/experimental repo with batch-mode pipelines, evaluation tooling, and the v1 extension. This repo is scoped to just the streaming v2 stack.

## License

[MIT](LICENSE)
