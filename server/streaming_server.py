"""
FastAPI WebSocket endpoint for the streaming translation pipeline.

A single bidirectional WebSocket connection handles:
  - Binary frames: raw PCM16 audio from extension -> Deepgram
  - JSON text frames: control messages (config, heartbeat, video_position)
  - JSON text frames: translated audio metadata + binary audio chunks back

Mount this alongside the existing REST API in api_server.py.
"""

from __future__ import annotations

import json
import logging
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from starlette.websockets import WebSocketState

from protocol import (
    SessionReadyMsg,
    HeartbeatAckMsg,
    ErrorMsg,
    encode_msg,
    decode_client_msg,
)
from session import Session

logger = logging.getLogger(__name__)

app = FastAPI(title="Streaming Translation API")


@app.websocket("/ws/translate")
async def ws_translate(
    websocket: WebSocket,
    source: str = Query(default="en"),
    target: str = Query(default="es"),
):
    """Main WebSocket endpoint for live streaming translation.

    Client sends:
      - JSON: {"type": "config", ...} (once, optional -- overrides query params)
      - Binary: PCM16 audio frames (200ms = 6400 bytes at 16kHz mono)
      - JSON: {"type": "heartbeat"}
      - JSON: {"type": "video_position", "time_sec": ...}
      - JSON: {"type": "end_stream"}

    Server sends:
      - JSON: session_ready, utterance_start, utterance_end, caption, speaker_cloned, error
      - Binary: MP3 audio chunks (between utterance_start and utterance_end)
    """
    await websocket.accept()
    logger.info("WebSocket connected (source=%s, target=%s)", source, target)

    source_lang = source
    target_lang = target
    session: Session | None = None

    async def send_text(msg: str):
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.send_text(msg)

    async def send_bytes(data: bytes):
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.send_bytes(data)

    tts_provider = os.environ.get("TTS_PROVIDER", "elevenlabs")

    try:
        # Create session
        session = Session(
            source_lang=source_lang,
            target_lang=target_lang,
            send_text=send_text,
            send_bytes=send_bytes,
            tts_provider=tts_provider,
        )
        await session.start()

        # Notify client
        await send_text(encode_msg(SessionReadyMsg(session_id=session.session_id)))

        # Main message loop
        while True:
            message = await websocket.receive()

            if message.get("type") == "websocket.disconnect":
                break

            if "bytes" in message and message["bytes"]:
                # Binary frame: PCM16 audio
                await session.receive_audio(message["bytes"])

            elif "text" in message and message["text"]:
                # JSON text frame: control message
                try:
                    data = decode_client_msg(message["text"])
                except json.JSONDecodeError:
                    continue

                msg_type = data.get("type")

                if msg_type == "config":
                    # Update language settings (only before first audio)
                    new_source = data.get("source_lang", source_lang)
                    new_target = data.get("target_lang", target_lang)
                    if new_source != source_lang or new_target != target_lang:
                        source_lang = new_source
                        target_lang = new_target
                        # Restart session with new languages
                        await session.stop()
                        session = Session(
                            source_lang=source_lang,
                            target_lang=target_lang,
                            send_text=send_text,
                            send_bytes=send_bytes,
                            tts_provider=tts_provider,
                        )
                        await session.start()
                        await send_text(
                            encode_msg(SessionReadyMsg(session_id=session.session_id))
                        )

                elif msg_type == "heartbeat":
                    await send_text(encode_msg(HeartbeatAckMsg()))

                elif msg_type == "video_position":
                    # Could use for sync telemetry; currently informational
                    pass

                elif msg_type == "end_stream":
                    logger.info("Client sent end_stream")
                    break

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception as e:
        logger.error("WebSocket error: %s", e, exc_info=True)
        try:
            await send_text(encode_msg(ErrorMsg(message=str(e), recoverable=False)))
        except Exception:
            pass
    finally:
        if session:
            await session.stop()
        logger.info("WebSocket session cleaned up")


# Health check
@app.get("/health")
async def health():
    return {"status": "ok"}
