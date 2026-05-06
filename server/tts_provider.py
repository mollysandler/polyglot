"""
TTS provider abstraction layer.

Defines a common interface for text-to-speech synthesis with three
concrete implementations: ElevenLabs, OpenAI, and Cartesia.

Each provider translates a provider-agnostic VoiceDirective into
its own parameters (stability, instructions, emotion tags, etc.).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator, Optional

import websockets

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Voice directive (provider-agnostic per-utterance style hints)
# ---------------------------------------------------------------------------


@dataclass
class VoiceDirective:
    """Per-utterance emotion/style hints passed to TTS providers.

    Each provider interprets these in its own way:
      - ElevenLabs: maps to stability, style, speed voice_settings
      - OpenAI: maps to an instructions string
      - Cartesia: maps to emotion control tags
    """

    emotion: str = "neutral"  # "excited", "calm", "urgent", "curious", etc.
    energy: float = 0.5  # 0.0 (subdued) to 1.0 (maximum energy)
    speed: float = 1.0  # speaking rate multiplier


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------


class TTSProvider(ABC):
    """Abstract base for TTS providers."""

    @property
    @abstractmethod
    def provider_name(self) -> str: ...

    @abstractmethod
    async def synthesize(
        self,
        text: str,
        voice_id: str,
        directive: Optional[VoiceDirective] = None,
    ) -> AsyncIterator[bytes]:
        """Synthesize text, yielding MP3 audio chunks as they arrive."""
        ...

    @abstractmethod
    async def close(self) -> None: ...


# ---------------------------------------------------------------------------
# ElevenLabs Flash v2.5 (WebSocket streaming)
# ---------------------------------------------------------------------------


class ElevenLabsProvider(TTSProvider):
    """ElevenLabs Flash v2.5 via WebSocket streaming TTS."""

    WS_BASE = "wss://api.elevenlabs.io/v1/text-to-speech"

    def __init__(self, api_key: Optional[str] = None):
        self._api_key = api_key or os.environ["ELEVENLABS_API_KEY"]

    @property
    def provider_name(self) -> str:
        return "elevenlabs"

    def _directive_to_settings(self, directive: VoiceDirective) -> dict:
        """Translate VoiceDirective to ElevenLabs voice_settings."""
        # Base settings tuned for real-time streaming
        stability = 0.35
        style = 0.0
        speed = directive.speed

        # Map emotion/energy to stability and style
        if directive.emotion in ("excited", "enthusiastic"):
            stability = max(0.20, 0.35 - directive.energy * 0.15)
            style = min(0.3, directive.energy * 0.3)
        elif directive.emotion == "urgent":
            stability = 0.25
            style = 0.2
            speed = max(speed, 1.05)
        elif directive.emotion == "calm":
            stability = 0.50
            style = 0.0
        elif directive.emotion == "curious":
            stability = 0.40
            style = 0.1

        return {
            "stability": stability,
            "similarity_boost": 0.75,
            "style": style,
            "use_speaker_boost": False,
            "speed": speed,
        }

    async def synthesize(
        self,
        text: str,
        voice_id: str,
        directive: Optional[VoiceDirective] = None,
    ) -> AsyncIterator[bytes]:
        directive = directive or VoiceDirective()
        settings = self._directive_to_settings(directive)

        url = (
            f"{self.WS_BASE}/{voice_id}/stream-input"
            f"?model_id=eleven_flash_v2_5"
            f"&output_format=mp3_44100_64"
            f"&inactivity_timeout=30"
        )
        ws = await websockets.connect(
            url,
            additional_headers={"xi-api-key": self._api_key},
        )
        try:
            # BOS: space + voice settings
            bos = {
                "text": " ",
                "voice_settings": settings,
                "generation_config": {
                    "chunk_length_schedule": [100, 140, 200, 260],
                },
            }
            await ws.send(json.dumps(bos))

            # Send text with flush
            msg = {
                "text": text + " ",
                "try_trigger_generation": True,
                "flush": True,
            }
            await ws.send(json.dumps(msg))

            # Send EOS
            await ws.send(json.dumps({"text": ""}))

            # Receive audio chunks until isFinal
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=30.0)
                    data = json.loads(raw)
                    if data.get("isFinal"):
                        break
                    audio_b64 = data.get("audio")
                    if audio_b64:
                        yield base64.b64decode(audio_b64)
                except (websockets.exceptions.ConnectionClosed, asyncio.TimeoutError):
                    break
        finally:
            await ws.close()

    async def close(self) -> None:
        pass  # connections are per-utterance


# ---------------------------------------------------------------------------
# OpenAI gpt-4o-mini-tts (HTTP streaming)
# ---------------------------------------------------------------------------


class OpenAITTSProvider(TTSProvider):
    """OpenAI TTS via HTTP streaming. Uses the `instructions` parameter
    for per-utterance emotion/style control."""

    API_URL = "https://api.openai.com/v1/audio/speech"

    def __init__(self, api_key: Optional[str] = None):
        self._api_key = api_key or os.environ["OPENAI_API_KEY"]

    @property
    def provider_name(self) -> str:
        return "openai"

    def _directive_to_instructions(self, directive: VoiceDirective) -> str:
        """Translate VoiceDirective to an OpenAI instructions string."""
        parts = []

        emotion_map = {
            "excited": "Speak with excitement and high energy.",
            "enthusiastic": "Speak with enthusiasm and warmth.",
            "urgent": "Speak with urgency and intensity.",
            "calm": "Speak in a calm, measured tone.",
            "curious": "Speak with a curious, questioning tone.",
            "neutral": "Speak naturally and clearly.",
        }
        parts.append(emotion_map.get(directive.emotion, "Speak naturally."))

        if directive.energy > 0.7:
            parts.append("Use a dynamic, energetic delivery.")
        elif directive.energy < 0.3:
            parts.append("Keep the delivery subdued and gentle.")

        if directive.speed > 1.05:
            parts.append("Speak slightly faster than normal.")
        elif directive.speed < 0.95:
            parts.append("Speak slightly slower than normal.")

        return " ".join(parts)

    async def synthesize(
        self,
        text: str,
        voice_id: str,
        directive: Optional[VoiceDirective] = None,
    ) -> AsyncIterator[bytes]:
        import httpx

        directive = directive or VoiceDirective()
        instructions = self._directive_to_instructions(directive)

        body = {
            "model": "gpt-4o-mini-tts",
            "input": text,
            "voice": voice_id,
            "instructions": instructions,
            "response_format": "mp3",
            "speed": directive.speed,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            async with client.stream(
                "POST",
                self.API_URL,
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                },
                json=body,
            ) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes(chunk_size=4096):
                    if chunk:
                        yield chunk

    async def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Cartesia Sonic (WebSocket streaming)
# ---------------------------------------------------------------------------


class CartesiaTTSProvider(TTSProvider):
    """Cartesia Sonic TTS via WebSocket streaming."""

    WS_URL = "wss://api.cartesia.ai/tts/websocket"

    def __init__(self, api_key: Optional[str] = None):
        self._api_key = api_key or os.environ["CARTESIA_API_KEY"]

    @property
    def provider_name(self) -> str:
        return "cartesia"

    def _directive_to_controls(self, directive: VoiceDirective) -> dict:
        """Translate VoiceDirective to Cartesia emotion/speed controls."""
        controls = {}

        # Cartesia supports emotion tags and speed
        emotion_map = {
            "excited": "positivity:high",
            "enthusiastic": "positivity:high",
            "urgent": "speed:fast",
            "calm": "positivity:low",
            "curious": "curiosity:high",
        }
        if directive.emotion in emotion_map:
            controls["emotion"] = [emotion_map[directive.emotion]]

        if directive.speed != 1.0:
            controls["speed"] = directive.speed

        return controls

    async def synthesize(
        self,
        text: str,
        voice_id: str,
        directive: Optional[VoiceDirective] = None,
    ) -> AsyncIterator[bytes]:
        directive = directive or VoiceDirective()
        controls = self._directive_to_controls(directive)

        url = f"{self.WS_URL}?api_key={self._api_key}&cartesia_version=2024-06-10"
        ws = await websockets.connect(url)
        try:
            import uuid

            context_id = str(uuid.uuid4())

            msg = {
                "context_id": context_id,
                "model_id": "sonic-2",
                "transcript": text,
                "voice": {
                    "mode": "id",
                    "id": voice_id,
                },
                "output_format": {
                    "container": "raw",
                    "encoding": "mp3",
                    "sample_rate": 44100,
                },
                "language": "en",
                "continue": False,
            }

            # Add emotion/speed controls if present
            if controls.get("speed"):
                msg["voice"]["__experimental_controls"] = {"speed": controls["speed"]}

            await ws.send(json.dumps(msg))

            # Receive audio chunks
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=30.0)
                    data = json.loads(raw)
                    if data.get("done"):
                        break
                    audio_b64 = data.get("data")
                    if audio_b64:
                        yield base64.b64decode(audio_b64)
                except (websockets.exceptions.ConnectionClosed, asyncio.TimeoutError):
                    break
        finally:
            await ws.close()

    async def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def create_tts_provider(
    provider_name: Optional[str] = None,
    api_key: Optional[str] = None,
) -> TTSProvider:
    """Create a TTS provider by name. Defaults to TTS_PROVIDER env var or elevenlabs."""
    name = (provider_name or os.environ.get("TTS_PROVIDER", "elevenlabs")).lower()

    if name == "elevenlabs":
        return ElevenLabsProvider(api_key=api_key)
    elif name == "openai":
        return OpenAITTSProvider(api_key=api_key)
    elif name == "cartesia":
        return CartesiaTTSProvider(api_key=api_key)
    else:
        raise ValueError(f"Unknown TTS provider: {name}")
