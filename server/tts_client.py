"""
TTS client facade.

Thin wrapper around TTSProvider implementations. Session code uses this
class so that switching providers is a one-line configuration change.
"""

from __future__ import annotations

from typing import AsyncIterator, Optional

from tts_provider import TTSProvider, VoiceDirective, create_tts_provider


class TTSClient:
    """Session-facing TTS interface. Delegates to the active TTSProvider."""

    def __init__(
        self,
        provider: Optional[str] = None,
        api_key: Optional[str] = None,
    ):
        self._provider: TTSProvider = create_tts_provider(provider, api_key)

    @property
    def provider_name(self) -> str:
        return self._provider.provider_name

    async def synthesize(
        self,
        text: str,
        voice_id: str,
        directive: Optional[VoiceDirective] = None,
    ) -> AsyncIterator[bytes]:
        """Synthesize text with the given voice, yielding MP3 chunks."""
        async for chunk in self._provider.synthesize(text, voice_id, directive):
            yield chunk

    async def close(self) -> None:
        """Clean up provider resources."""
        await self._provider.close()
