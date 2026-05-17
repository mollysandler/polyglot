<p align="center">
  <img src="extension/icons/icon512.png" alt="Polyglot" width="120" />
</p>

# Polyglot

**A Chrome extension for real-time speech translation in the browser.** Translate the audio of any tab — livestreams, sports, podcasts, lectures — into your language as you watch. Or speak into your microphone and have your own voice translated for someone else. Captions appear per speaker in the side panel; translated audio plays back in seconds, in a voice picked to match the original speaker's gender and pitch.

Two parts: a Chromium Manifest V3 extension that captures audio and runs the UI, and a Python WebSocket backend that handles ASR → translation → TTS.

> **Status:** working prototype, MIT-licensed. Runs entirely on your machine by default. Remote deployment to your own [Modal](https://modal.com) account is opt-in through a side-panel setting — Polyglot itself hosts nothing.

---

## Two capture modes

**Tab audio (default).** Captures whatever is playing in the active Chromium tab. The tab is muted, and a frame-delayed canvas overlay keeps the picture in step with the translated dub. Use this for livestreams, foreign-language video, lectures, and podcasts.

**Microphone.** Captures your own voice. Translated audio is recorded silently during capture and offered for one-click playback when you click **Done**, so you can speak without the dub talking over you. Use this for short conversations across a language barrier or to produce translated voice memos.

## Quick start

1. **Get three API keys** — Deepgram, ElevenLabs, Google Translate. All have free tiers.
2. **Run the backend** locally: `cd server && python run_streaming.py` after a one-time setup.
3. **Load the extension** in Chrome via `chrome://extensions → Load unpacked`.
4. **Click Start** in the side panel.

Full step-by-step below.

---

## Architecture

```
extension/    Chromium MV3 extension — side panel UI, offscreen audio
              capture, canvas overlay, WebSocket client
server/       Python streaming backend — FastAPI WebSocket, Deepgram
              ASR, Google Translate, ElevenLabs TTS, ECAPA-TDNN
              speaker re-clustering
server/tests/ Backend unit tests
```

```
tab audio / mic ─► extension  (PCM16 @ 16 kHz, 200 ms frames)
                ─► ws://server/ws/translate
                ─► Deepgram Nova-3            (streaming ASR + diarization)
                ─► ECAPA-TDNN re-clustering   (stabilizes speaker IDs across long sessions)
                ─► Google Translate
                ─► ElevenLabs Flash v2.5      (streaming TTS, pitch/gender-matched stock voice)
                ─► MP3 chunks back to extension ─► gapless playback
```

**Audio-video sync (tab mode).** The content script renders a frame-delayed `<canvas>` overlay on top of the original `<video>` (hidden via `opacity: 0`) so the picture stays in step with the translated audio. On DRM-protected players where canvas readback is blocked (Netflix, some Twitch streams), it falls back to a one-shot seek-back. Screen-vs-audio drift is closed with small `playbackRate` adjustments. Engineering details in [`extension/BUGS.md`](extension/BUGS.md).

---

## Setup

### 1. Get API keys

| Service | Used for | Sign up | Free tier |
|---|---|---|---|
| **Deepgram** | Streaming ASR + diarization | https://console.deepgram.com/signup | $200 credit, no card |
| **ElevenLabs** | Streaming TTS | https://elevenlabs.io/sign-up | 10 k chars / month |
| **Google Cloud Translate** | Text translation | https://console.cloud.google.com/ | $10 / month free, up to 500 k chars |

Google Translate has the most involved setup:

1. Create or pick a Google Cloud project.
2. Enable the **Cloud Translation API** ([direct link](https://console.cloud.google.com/apis/library/translate.googleapis.com)).
3. Create a service account → add the **Cloud Translation API User** role → create a JSON key → download.
4. Save the JSON file somewhere outside the repo (e.g. `~/google_keys.json`) and put its absolute path in `.env` as `GOOGLE_APPLICATION_CREDENTIALS`.

### 2. Configure your `.env`

```bash
cp .env.example .env
$EDITOR .env      # fill in DEEPGRAM_API_KEY, ELEVENLABS_API_KEY,
                  # GOOGLE_APPLICATION_CREDENTIALS
```

`.env` lives at the repo root and is loaded by the backend at startup.

### 3. Run the backend

```bash
cd server
python -m venv .venv && source .venv/bin/activate    # macOS / Linux
# Windows: python -m venv .venv && .venv\Scripts\activate
pip install -r requirements_streaming.txt
python run_streaming.py                              # serves ws://localhost:8765/ws/translate
```

Leave that terminal running.

### 4. Install the extension

```bash
cd extension
npm install
```

In Chrome:

1. Visit `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` directory
4. Click the Polyglot icon in the toolbar to open the side panel

### 5. Translate something

In the side panel:

1. Pick **source** and **target** languages
2. (Optional) Toggle **Microphone** instead of the default **Tab audio**
3. Open a tab with audio (any livestream, YouTube clip, etc.) and click **Start Translating**

After ~30 s of buffering, translated audio starts and captions populate per speaker.

---

## Tab mode: sites to try

Polyglot works on **any browser tab that plays audio**. If a `<video>` element is present, the canvas overlay keeps the picture in sync; if not, you just get translated audio.

**With video:**
- Any non-English YouTube clip — e.g. a [DW News interview (DE)](https://www.youtube.com/results?search_query=dw+news+interview+deutsch), a [France 24 segment (FR)](https://www.youtube.com/results?search_query=france+24+en+direct), or a [LaLiga highlight (ES)](https://www.youtube.com/results?search_query=laliga+resumen). Pick a clip that's already started playing before clicking Start.
- Twitch streams in non-English channels — esports broadcasts in Korean or Spanish work especially well.

**Audio-only (no `<video>`):**
- [BBC World Service (EN)](https://www.bbc.com/audio/play/live/bbc_world_service)
- [Deutschlandfunk live (DE)](https://www.deutschlandfunk.de/livestream)
- [France Info live (FR)](https://www.francetvinfo.fr/en-direct/radio.html)
- [NHK World Radio (JA)](https://www3.nhk.or.jp/nhkworld/en/live/)
- [RAI Radio 1 (IT)](https://www.raiplaysound.it/dirette/radio1)
- [RNE Radio Nacional (ES)](https://www.rtve.es/play/audios/directo/radio-nacional/)

**Live-stream caveat.** The pipeline needs ~5–10 s of headroom for ASR → translation → TTS, so you can't listen at the **true live edge**. On live radio / YouTube / Twitch, **seek back 30–60 s** before clicking Start so there's already-aired content to translate, or wait until the player has built a back-buffer. If you click Start exactly at the live edge with nothing buffered, the captions panel will sit empty until enough audio plays through.

## Microphone mode details

Mic mode shares the entire downstream pipeline with tab mode — only the capture step changes. Toggle **Microphone** at the top of the side panel before clicking **Start**.

Chrome will prompt for microphone permission on first use. If the side panel can't surface the prompt (a known Chrome quirk on some installs), Polyglot opens a small helper window with a cleaner surface for it — grant permission there, close the window, and click Start again.

**Mic mode is silent during recording.** Live captions appear, but the translated dub does not play in real time — that would create a feedback loop. The Start/Stop button reads **Done** in mic mode; clicking it ends recording and offers a **Play / Discard** prompt for the buffered translated audio.

---

## Optional: deploy your own Modal backend

The local backend costs nothing to run but only works while your laptop is on and reachable. For across-device or always-on use, deploy the same backend to your own [Modal](https://modal.com) account. Polyglot hosts nothing on your behalf — you bring your own Modal account and API keys, and pay only for your own usage.

```bash
# 1. Install Modal and authenticate against YOUR account (free tier available).
pip install modal
modal token new

# 2. In your Modal dashboard, go to Settings → Secrets → New, name it
#    "sports-secrets", and add these entries:
#       DEEPGRAM_API_KEY
#       ELEVENLABS_API_KEY
#       GOOGLE_APPLICATION_CREDENTIALS_JSON   (paste the JSON contents itself,
#                                              not a file path)
#       HUGGING_FACE_TOKEN

# 3. Deploy. Modal prints a URL on your subdomain.
cd server
modal deploy modal_app_v2.py
# → https://<your-username>--polyglot-streamingservice-web.modal.run

# 4. In the side panel, expand "Backend & settings", paste the URL
#    (replace https:// with wss://) and click Save. Chrome will prompt
#    you to grant access for *.modal.run — accept.
#
#    Final stored value:
#       wss://<your-username>--polyglot-streamingservice-web.modal.run
```

No shared credentials, no shared bill — each user owns their deployment outright.

---

## Tests

```bash
cd server   && pytest tests/ -q       # 79 backend tests
cd extension && npm test              # 410 extension tests
```

## Project notes

**Bring-your-own-keys, bring-your-own-backend.** Every user supplies their own Deepgram / ElevenLabs / Google Translate keys via `.env`, and chooses where the backend runs. Default is `localhost`; the side panel's Backend URL setting can point at any `ws://` or `wss://` endpoint after a runtime permission grant. The project hosts nothing on your behalf.

**Origin.** This repo is the canonical, paper-referenced Polyglot codebase, scoped to the streaming pipeline and the Chrome extension. It was extracted from the broader [sport-translations](https://github.com/mollysandler/sport-translations) exploratory repo, which also contains batch-mode tooling, evaluation scripts, and a v1 extension.

## License

[MIT](LICENSE)
