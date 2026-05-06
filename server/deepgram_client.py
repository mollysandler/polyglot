"""
Async wrapper around Deepgram Nova-3 WebSocket streaming API.

Provides real-time ASR with speaker diarization. Emits Utterance objects
as Deepgram finalizes transcript segments.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Callable, Optional

from protocol import Utterance

logger = logging.getLogger(__name__)

# Force-flush an accumulated utterance after this many seconds even if
# speech_final / UtteranceEnd hasn't fired. Prevents indefinite buffering
# when a speaker doesn't pause long enough for Deepgram's utterance detector.
# 5s was too aggressive for continuous speakers (journalists, commentators,
# lecturers) who speak in long flowing sentences without natural pause breaks,
# causing mid-sentence cuts. 10s gives room for full thoughts while still
# bounding memory and latency.
MAX_ACCUMULATION_SEC = 10.0


class DeepgramStream:
    """Manages a single Deepgram streaming WebSocket connection.

    Audio is forwarded as raw PCM16 bytes. Final transcript utterances
    (with speaker labels) are dispatched via *on_utterance* callback.
    """

    def __init__(
        self,
        *,
        language: str = "en",
        on_utterance: Optional[Callable[[Utterance], None]] = None,
        on_utterance_end: Optional[Callable[[], None]] = None,
        api_key: Optional[str] = None,
        utterance_end_ms: int = 2000,
    ):
        self._api_key = api_key or os.environ["DEEPGRAM_API_KEY"]
        self._language = language
        self._utterance_end_ms = utterance_end_ms
        self.on_utterance = on_utterance
        self.on_utterance_end = on_utterance_end

        self._connection = None
        self._ctx = None
        self._listen_task: Optional[asyncio.Task] = None
        self._keepalive_task: Optional[asyncio.Task] = None
        self._connected = asyncio.Event()
        self._closed = asyncio.Event()
        self._last_audio_time: float = 0

        # Accumulate words for the current utterance across is_final events.
        # Flush only when speech_final=true (Deepgram detected end of utterance)
        # or UtteranceEnd (utterance_end_ms silence reached) or MAX_ACCUMULATION_SEC
        # timeout. Treating every is_final as an utterance fragments sentences
        # mid-thought and destroys translation quality.
        self._pending_words: list[dict] = []
        self._pending_start_time: float = 0.0
        # Dedup: recent emitted texts (window of 20) + timestamp high-water mark
        from collections import deque

        self._recent_emitted: deque[str] = deque(maxlen=20)
        self._last_emitted_end_sec: float = 0.0
        self._last_is_final_time: float = 0.0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self):
        """Open the Deepgram WebSocket and begin listening."""
        from deepgram import AsyncDeepgramClient
        from deepgram.core.events import EventType

        client = AsyncDeepgramClient(api_key=self._api_key)

        self._ctx = client.listen.v1.connect(
            model="nova-3",
            encoding="linear16",
            sample_rate=16000,
            channels=1,
            diarize="true",
            punctuate="true",
            smart_format="true",
            interim_results="true",
            utterance_end_ms=str(self._utterance_end_ms),
            vad_events="true",
            language=self._language,
        )
        self._connection = await self._ctx.__aenter__()

        self._connection.on(EventType.OPEN, self._on_open)
        self._connection.on(EventType.MESSAGE, self._on_message)
        self._connection.on(EventType.ERROR, self._on_error)
        self._connection.on(EventType.CLOSE, self._on_close)

        self._listen_task = asyncio.create_task(self._connection.start_listening())
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())
        await self._connected.wait()
        logger.info("Deepgram stream started (lang=%s)", self._language)

    async def send_audio(self, pcm16_bytes: bytes):
        """Forward raw PCM16 audio to Deepgram."""
        if self._connection is None:
            raise RuntimeError("Deepgram stream not started")
        await self._connection.send_media(pcm16_bytes)
        self._last_audio_time = asyncio.get_event_loop().time()

    async def _keepalive_loop(self):
        """Send periodic keep-alive to Deepgram when no audio is flowing.

        Deepgram closes the connection after ~10-15s of inactivity.
        During the replay zone, the extension stops sending audio for ~30s.
        This loop prevents the timeout.
        """
        while not self._closed.is_set():
            await asyncio.sleep(5)  # check every 5 seconds
            if self._connection is None or self._closed.is_set():
                break
            elapsed = asyncio.get_event_loop().time() - self._last_audio_time
            if elapsed > 4:  # no audio for 4+ seconds — send keep-alive
                try:
                    await self._connection.send_keep_alive()
                    logger.debug("Deepgram keep-alive sent (idle %.1fs)", elapsed)
                except Exception as e:
                    logger.warning("Deepgram keep-alive failed: %s", e)
                    # Don't break — keep trying

    async def stop(self):
        """Gracefully close the Deepgram connection."""
        if self._keepalive_task:
            self._keepalive_task.cancel()
            self._keepalive_task = None
        if self._connection:
            try:
                await self._connection.send_close_stream()
            except Exception:
                pass
        if self._listen_task:
            try:
                await asyncio.wait_for(self._listen_task, timeout=5.0)
            except (asyncio.TimeoutError, Exception):
                self._listen_task.cancel()
        if self._ctx:
            try:
                await self._ctx.__aexit__(None, None, None)
            except Exception:
                pass
        self._connection = None
        self._closed.set()
        logger.info("Deepgram stream stopped")

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------

    async def _on_open(self, _):
        self._connected.set()

    async def _on_message(self, message):
        from deepgram.listen.v1.types.listen_v1results import ListenV1Results
        from deepgram.listen.v1.types.listen_v1utterance_end import ListenV1UtteranceEnd

        if isinstance(message, ListenV1Results):
            self._handle_results(message)
        elif isinstance(message, ListenV1UtteranceEnd):
            self._handle_utterance_end()

    def _handle_results(self, message):
        """Handle a ListenV1Results message. Extracted for testability."""
        alt = (
            message.channel.alternatives[0]
            if message.channel and message.channel.alternatives
            else None
        )
        if alt is None or not alt.transcript:
            return

        # Collect words with speaker info
        words = []
        for w in alt.words or []:
            words.append(
                {
                    "word": w.punctuated_word or w.word,
                    "speaker": int(w.speaker) if w.speaker is not None else -1,
                    "start": w.start,
                    "end": w.end,
                }
            )

        if message.is_final:
            import time as _time

            # Deepgram emits multiple is_final=true segments per actual
            # utterance. Accumulate across them; only flush when
            # speech_final=true signals end of the logical utterance
            # (triggered by utterance_end_ms silence) or a safety timeout.
            speech_final = bool(getattr(message, "speech_final", False))

            if not self._pending_words:
                self._pending_start_time = _time.monotonic()
            self._pending_words.extend(words)

            elapsed = _time.monotonic() - self._pending_start_time
            if speech_final or elapsed >= MAX_ACCUMULATION_SEC:
                all_words = self._pending_words
                self._pending_words = []
                self._pending_start_time = 0.0
                self._last_is_final_time = _time.monotonic()
                if all_words:
                    self._emit_utterances(all_words)
        # else: interim result — ignore. Only finalized words are stable.

    def _handle_utterance_end(self):
        """Handle a ListenV1UtteranceEnd event. Extracted for testability."""
        import time as _time

        # Guard: if speech_final just fired, pending_words is already flushed.
        # Skip the UtteranceEnd flush to avoid re-emitting the same content.
        if _time.monotonic() - self._last_is_final_time < 0.15:
            if self.on_utterance_end:
                self.on_utterance_end()
            return
        # Flush any accumulated words as an utterance
        if self._pending_words:
            self._emit_utterances(self._pending_words)
            self._pending_words = []
            self._pending_start_time = 0.0
        if self.on_utterance_end:
            self.on_utterance_end()

    async def _on_error(self, error):
        logger.error("Deepgram error: %s", error)

    async def _on_close(self, _):
        self._closed.set()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _emit_utterances(self, words: list[dict]):
        """Group words by speaker and emit one Utterance per speaker run."""
        if not words or not self.on_utterance:
            return

        # Group consecutive words by speaker
        runs: list[list[dict]] = []
        current_run: list[dict] = [words[0]]
        for w in words[1:]:
            if w["speaker"] == current_run[-1]["speaker"]:
                current_run.append(w)
            else:
                runs.append(current_run)
                current_run = [w]
        runs.append(current_run)

        for run in runs:
            text = " ".join(w["word"] for w in run)
            if not text.strip():
                continue

            # Dedup: timestamp — skip if this run's time range is already covered
            run_end = run[-1]["end"]
            if run_end <= self._last_emitted_end_sec + 0.05:
                continue

            # Dedup: text — skip if recently emitted (exact, substring, or contained)
            normalized = text.lower().strip()
            if normalized and any(
                normalized == prev or normalized in prev or prev in normalized
                for prev in self._recent_emitted
            ):
                continue

            self._recent_emitted.append(normalized)
            self._last_emitted_end_sec = max(self._last_emitted_end_sec, run_end)
            utterance = Utterance(
                text=text,
                speaker_id=run[0]["speaker"],
                start_sec=run[0]["start"],
                end_sec=run[-1]["end"],
            )
            self.on_utterance(utterance)
