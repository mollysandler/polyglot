<p align="center">
  <img src="extension/icons/icon512.png" alt="Polyglot" width="120" />
</p>

# Polyglot

**Real-time translation of any browser tab's audio.** Speak English on a livestream, hear it in Spanish (or 10+ other languages) within ~1–2 seconds, in a voice that matches the speaker. Captions in a side panel.

Two parts: a Chrome extension that captures tab audio, and a Python WebSocket server that handles ASR → translation → TTS.

> **Status:** working prototype. Runs entirely on your machine by default; users who prefer a remote backend can opt in to deploying it to their own [Modal](https://modal.com) account (see [Optional: deploy your own Modal backend](#optional-deploy-your-own-modal-backend)) without sharing infrastructure with anyone else.

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

Sync: by default, the content script renders a frame-delayed `<canvas>` overlay on top of the original `<video>` (hidden via `opacity:0`) so the picture stays in step with the translated audio. On DRM-protected players where canvas readback is blocked (Netflix, some Twitch streams), it falls back to a one-shot seek-back. Drift between screen and audio is closed by small `playbackRate` adjustments. See `extension/BUGS.md` for the long form of how the sync was hardened.

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

By default, the extension connects to `ws://localhost:8765`. To point it at a different backend (e.g.\ your own Modal deployment, see below), open the side panel, expand **Backend & settings**, paste a `ws://` or `wss://` URL, and click **Save**.

## What you can translate

Polyglot works on **any browser tab that plays audio**. Video is optional. If a `<video>` element is present we also keep the picture in sync with the dub; if not, you just get translated audio.

### Sample tabs to try

**Video (sync mode):**
- Any non-English YouTube clip works — try a [DW News interview (DE)](https://www.youtube.com/results?search_query=dw+news+interview+deutsch), a [France 24 segment (FR)](https://www.youtube.com/results?search_query=france+24+en+direct), or a [LaLiga highlight (ES)](https://www.youtube.com/results?search_query=laliga+resumen). Pick a clip that's already started playing before you click Start.
- Twitch streams in non-English channels — esports broadcasts in Korean or Spanish work especially well.

**Audio-only (no `<video>` element):**
- [BBC World Service (EN)](https://www.bbc.com/audio/play/live/bbc_world_service) — the page the live-stream caveat was discovered on
- [Deutschlandfunk live (DE)](https://www.deutschlandfunk.de/livestream)
- [France Info live (FR)](https://www.francetvinfo.fr/en-direct/radio.html)
- [NHK World Radio (JA)](https://www3.nhk.or.jp/nhkworld/en/live/)
- [RAI Radio 1 (IT)](https://www.raiplaysound.it/dirette/radio1)
- [RNE Radio Nacional (ES)](https://www.rtve.es/play/audios/directo/radio-nacional/)

### Live-stream caveat

The pipeline needs ~5–10 s of headroom for ASR → translation → TTS, so you can't listen at the **true live edge**. The extension is translating audio that already played; it can't translate audio that hasn't happened yet. On live radio / live YouTube / live Twitch:

- **Seek back 30–60 s** before clicking Start so there's already-aired content to translate
- Or wait until you've been on the page for a minute or two so the player has built a back-buffer

If you click Start at the exact live edge with nothing buffered, the captions panel will sit empty until enough audio plays through.

## Microphone mode

Polyglot has a second capture source: your own microphone. Useful when you want to *speak* in one language and have your words translated into another — e.g. talking to someone in person without a shared language, or producing a translated voice memo. The whole pipeline (ASR, diarization, translation, TTS) is the same; only the capture step changes.

Switch to it by toggling **Microphone** at the top of the side panel before clicking **Start**. Chrome will prompt for microphone permission on first use. If the side panel can't surface the prompt (a known Chrome quirk in some installs), Polyglot opens a small helper window that has a cleaner surface for the prompt — grant permission there, close the window, and click Start again.

**Mic mode is silent during recording.** You'll see live captions in the side panel but won't hear the translated dub in real time. Playing it back while you're still talking would create a feedback loop and make it hard to follow your own thread. The Start/Stop button reads **Done** in mic mode; clicking it ends recording and offers a **Play / Discard** prompt for the buffered translated audio.

## Optional: deploy your own Modal backend

The local backend has zero hosting cost but only works while your laptop is running and reachable. If you'd rather have the backend live somewhere else — across devices, on a server, or just so you can close your laptop — you can deploy the same backend to your own [Modal](https://modal.com) account. Polyglot itself hosts nothing; you bring your own Modal account, your own API keys, and pay for your own usage. No other Polyglot user touches your deployment or quota.

```bash
# 1. Install Modal and authenticate against YOUR account (free tier available).
pip install modal
modal token new

# 2. Create a Modal Secret named "sports-secrets" in your Modal dashboard
#    (Settings → Secrets → New) containing:
#      DEEPGRAM_API_KEY
#      ELEVENLABS_API_KEY
#      GOOGLE_APPLICATION_CREDENTIALS_JSON   (the JSON itself, not a file path)
#      HUGGING_FACE_TOKEN

# 3. Deploy. Modal will print a URL on your subdomain.
cd server
modal deploy modal_app_v2.py
# → https://<your-username>--polyglot-streamingservice-web.modal.run

# 4. In the extension side panel, open "Backend & settings", paste the URL
#    (replacing https:// with wss:// and adding nothing else), then Save.
#    Chrome will prompt you to grant access for *.modal.run. Accept.
#
#    Final stored value looks like:
#      wss://<your-username>--polyglot-streamingservice-web.modal.run
```

That's it. Each user owns their deployment outright; no shared credentials, no shared bill.

## Tests

```bash
# Backend (79 tests)
cd server && pytest tests/ -q

# Extension (410 tests, 7 for BYO-Modal)
cd extension && npm test
```

## Distribution model

Today Polyglot is **bring-your-own-keys** AND **bring-your-own-backend**: every user supplies their own Deepgram / ElevenLabs / Google Translate keys via `.env`, and chooses where the backend runs — the install default is `localhost`, and the side panel exposes a Backend URL setting that lets you point it at any `ws://` or `wss://` endpoint (e.g. your own Modal deployment) after a runtime permission grant.

Two possible next steps for non-technical users:

1. **Chrome Web Store listing + hosted backend.** Loses the BYO property; needs a moderation and billing story.
2. **Drop the backend entirely.** Extension calls Deepgram + ElevenLabs + a translation API directly using user-supplied keys. Zero infra. Loses the PyTorch-based speaker clustering in `server/speaker_embedder.py` (browser can't run the ECAPA-TDNN model).

Decision pending.

## Origin

Imported from [sport-translations](https://github.com/mollysandler/sport-translations), which remains the working/experimental repo with batch-mode pipelines, evaluation tooling, and the v1 extension. This repo is scoped to just the streaming v2 stack.

## License

[MIT](LICENSE)
