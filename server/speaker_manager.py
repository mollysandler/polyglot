"""
Speaker tracking and voice assignment.

Maintains a mapping from Deepgram speaker_id -> TTS voice. Accumulates
audio per speaker, analyzes pitch/gender/energy, and assigns the best
matching voice via VoiceMatcher. Voices are locked after analysis.

No voice cloning — uses stock/preset voices only.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

import numpy as np

from voice_catalog import VoiceEntry, VoiceMatcher
from utils import estimate_pitch_yin, gender_from_pitch

logger = logging.getLogger(__name__)

# Analysis threshold: seconds of audio needed before pitch/gender analysis
ANALYSIS_THRESHOLD_SEC = 3.0


class SpeakerInfo:
    """State for a single tracked speaker."""

    def __init__(self, speaker_id: int):
        self.speaker_id = speaker_id
        self.voice_entry: Optional[VoiceEntry] = None
        self.gender: str = "male"
        self.avg_pitch: float = 150.0
        self.energy: float = 0.5
        self.is_locked: bool = False
        self.utterances_sent: int = 0  # how many utterances used this voice
        self.audio_samples: bytearray = bytearray()  # raw PCM16 @ 16kHz
        self.audio_sec: float = 0.0
        self.analysis_complete: asyncio.Event = asyncio.Event()

    @property
    def voice_id(self) -> Optional[str]:
        return self.voice_entry.voice_id if self.voice_entry else None


class SpeakerManager:
    """Manages speaker -> voice mapping with analysis and locking."""

    def __init__(self, matcher: VoiceMatcher):
        self._matcher = matcher
        self._speakers: dict[int, SpeakerInfo] = {}
        self._playback_started = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def is_new_speaker(self, speaker_id: int) -> bool:
        """Check if this speaker_id has never been seen. Does NOT register."""
        return speaker_id not in self._speakers

    def mark_playback_started(self) -> None:
        """Mark that playback has begun — new speakers after this trigger re-buffer."""
        self._playback_started = True

    @property
    def playback_started(self) -> bool:
        return self._playback_started

    def get_voice_id(self, speaker_id: int) -> str:
        """Get the current voice_id for a speaker. Assigns provisional voice if new."""
        info = self._speakers.get(speaker_id)
        if info is None:
            info = SpeakerInfo(speaker_id)
            # Assign a provisional voice with default characteristics
            entry = self._matcher.match_voice(
                gender=info.gender,
                avg_pitch=info.avg_pitch,
                energy=info.energy,
            )
            info.voice_entry = entry
            self._speakers[speaker_id] = info
            # Mark as used so the next speaker gets a different voice
            self._matcher._used_voice_ids.add(entry.voice_id)
            logger.info(
                "Speaker %d: provisional voice -> %s (%s)",
                speaker_id,
                entry.display_name,
                entry.voice_id,
            )
        return info.voice_id

    def mark_utterance_sent(self, speaker_id: int) -> None:
        """Record that an utterance was sent using this speaker's current voice."""
        info = self._speakers.get(speaker_id)
        if info:
            info.utterances_sent += 1

    def add_audio(self, speaker_id: int, pcm16_bytes: bytes) -> None:
        """Add captured audio for a speaker. Triggers analysis at threshold."""
        info = self._speakers.get(speaker_id)
        if info is None:
            # Auto-register
            self.get_voice_id(speaker_id)
            info = self._speakers[speaker_id]

        if info.is_locked:
            return  # Already analyzed and locked

        info.audio_samples.extend(pcm16_bytes)
        info.audio_sec = len(info.audio_samples) / (16000 * 2)  # 16kHz 16-bit

        # Analyze once we have enough audio
        if (
            info.audio_sec >= ANALYSIS_THRESHOLD_SEC
            and not info.analysis_complete.is_set()
        ):
            self._analyze_and_lock(info)

    async def wait_for_analysis(self, speaker_id: int, timeout: float = 5.0) -> bool:
        """Wait for a speaker's voice analysis to complete.

        Returns True if analysis completed, False on timeout.
        Used during re-buffer to block until the new speaker is analyzed.
        """
        info = self._speakers.get(speaker_id)
        if info is None:
            return False
        if info.analysis_complete.is_set():
            return True
        try:
            await asyncio.wait_for(info.analysis_complete.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            # Timeout — lock with whatever we have (provisional voice)
            logger.warning(
                "Speaker %d: analysis timed out after %.1fs (%.1fs audio). "
                "Locking with provisional voice.",
                speaker_id,
                timeout,
                info.audio_sec,
            )
            self._lock_speaker(info)
            return False

    # ------------------------------------------------------------------
    # Analysis
    # ------------------------------------------------------------------

    def _analyze_and_lock(self, info: SpeakerInfo) -> None:
        """Analyze pitch/gender/energy from accumulated audio and lock the voice."""
        try:
            pcm = (
                np.frombuffer(info.audio_samples, dtype=np.int16).astype(np.float32)
                / 32768.0
            )

            # Pitch estimation
            pitch = estimate_pitch_yin(pcm, 16000)
            if pitch is not None:
                info.avg_pitch = pitch
                info.gender = gender_from_pitch(pitch)

            # Energy estimation (RMS-based excitement level)
            rms = np.sqrt(np.mean(pcm**2))
            # Map RMS to 0-1 energy scale. Speech RMS typically 0.01-0.15.
            info.energy = min(1.0, max(0.0, (rms - 0.01) / 0.12))

            logger.info(
                "Speaker %d: analyzed — gender=%s, pitch=%.0fHz, energy=%.2f",
                info.speaker_id,
                info.gender,
                info.avg_pitch,
                info.energy,
            )
        except Exception as e:
            logger.warning("Speaker %d: analysis failed: %s", info.speaker_id, e)

        # Now pick the best voice based on actual characteristics
        new_entry = self._matcher.match_voice(
            gender=info.gender,
            avg_pitch=info.avg_pitch,
            energy=info.energy,
        )

        # Only swap voice if no utterances have been sent with the provisional one
        if info.utterances_sent == 0 and new_entry.voice_id != info.voice_id:
            logger.info(
                "Speaker %d: upgrading voice %s -> %s (%s)",
                info.speaker_id,
                info.voice_entry.display_name if info.voice_entry else "?",
                new_entry.display_name,
                new_entry.voice_id,
            )
            info.voice_entry = new_entry

        self._lock_speaker(info)

    def _lock_speaker(self, info: SpeakerInfo) -> None:
        """Lock the speaker's current voice permanently."""
        if info.is_locked:
            return
        info.is_locked = True
        if info.voice_entry:
            self._matcher.lock_voice(info.speaker_id, info.voice_entry)
        info.analysis_complete.set()
        # Free audio buffer — no longer needed
        info.audio_samples = bytearray()

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    async def cleanup(self) -> None:
        """Clean up all state."""
        self._speakers.clear()
        self._matcher.reset()
