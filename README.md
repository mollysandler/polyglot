# Polyglot

Real-time browser-tab translation. Chrome extension + streaming backend.

Imported from [sport-translations](https://github.com/mollysandler/sport-translations) — the working/experimental repo. This repo is the cleaned-up base for a production BYOK (bring-your-own-key) Chrome extension.

## Layout

```
extension/   Chrome Manifest V3 extension (side panel + offscreen audio capture + WebSocket client)
server/      Python streaming backend (FastAPI WebSocket, Deepgram ASR, ElevenLabs TTS, Google Translate)
server/tests/
```

## Pipeline

```
tab audio -> extension (PCM16 @ 16kHz, 200ms frames)
          -> ws://server/ws/translate
          -> Deepgram Nova-3 (streaming ASR + diarization)
          -> ECAPA-TDNN speaker clustering (corrects Deepgram speaker_id collapse)
          -> Google Translate
          -> ElevenLabs Flash v2.5 (streaming TTS)
          -> MP3 chunks back to extension -> gapless playback
```

## Run locally

### Backend

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements_streaming.txt
cp ../.env.example ../.env  # fill in keys
python run_streaming.py     # serves on ws://localhost:8765/ws/translate
```

### Extension

```bash
cd extension
npm install
```

Then in Chrome: `chrome://extensions` → Developer mode → Load unpacked → select `extension/`.

The extension is currently hardcoded to `ws://localhost:8765` (see `extension/offscreen/offscreen.js`) and the previous Modal URL in `manifest.json` host_permissions.

## BYOK direction

The current setup uses backend-side API keys. Production BYOK will require either:

- **Backend stays, accepts user keys via WS handshake.** Easier; still requires hosting.
- **Drop the backend; extension calls Deepgram + ElevenLabs + Translate directly.** True BYOK; loses the PyTorch-based speaker clustering (`server/speaker_embedder.py`).

TBD.

## Tests

```bash
cd server
pytest tests/ -q
```

```bash
cd extension
npm test
```
