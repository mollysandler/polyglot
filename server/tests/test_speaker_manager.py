"""Tests for speaker_manager.py."""

import asyncio
import pytest

from speaker_manager import SpeakerManager
from voice_catalog import VoiceMatcher


@pytest.fixture
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


def _make_matcher():
    return VoiceMatcher(provider="elevenlabs")


class TestSpeakerManager:
    def _make_manager(self):
        matcher = _make_matcher()
        mgr = SpeakerManager(matcher)
        return mgr, matcher

    def test_get_voice_id_assigns_provisional(self):
        mgr, matcher = self._make_manager()
        voice = mgr.get_voice_id(0)
        assert voice is not None
        assert isinstance(voice, str)
        assert len(voice) > 0

    def test_get_voice_id_reuses_existing(self):
        mgr, _ = self._make_manager()
        v1 = mgr.get_voice_id(0)
        v2 = mgr.get_voice_id(0)
        assert v1 == v2

    def test_multiple_speakers_get_different_voices(self):
        mgr, _ = self._make_manager()
        v0 = mgr.get_voice_id(0)
        v1 = mgr.get_voice_id(1)
        # Different speakers should get different voices (with enough in catalog)
        assert v0 != v1

    def test_is_new_speaker(self):
        mgr, _ = self._make_manager()
        assert mgr.is_new_speaker(0) is True
        mgr.get_voice_id(0)  # register
        assert mgr.is_new_speaker(0) is False
        assert mgr.is_new_speaker(1) is True

    def test_add_audio_accumulates(self):
        mgr, _ = self._make_manager()
        mgr.get_voice_id(0)
        pcm = b"\x00\x01" * 1600  # 0.1s at 16kHz
        mgr.add_audio(0, pcm)
        info = mgr._speakers[0]
        assert len(info.audio_samples) == len(pcm)
        assert info.audio_sec == pytest.approx(0.1, abs=0.01)

    def test_analysis_locks_voice(self):
        mgr, _ = self._make_manager()
        mgr.get_voice_id(0)
        # Add enough audio for analysis (3+ seconds of noise)
        import numpy as np

        rng = np.random.default_rng(42)
        samples = (rng.random(16000 * 4) * 2 - 1).astype(np.float32)
        pcm16 = (samples * 32767).astype(np.int16).tobytes()
        mgr.add_audio(0, pcm16)
        info = mgr._speakers[0]
        assert info.is_locked is True
        assert info.analysis_complete.is_set()

    def test_locked_voice_not_changed_by_more_audio(self):
        mgr, _ = self._make_manager()
        mgr.get_voice_id(0)
        import numpy as np

        rng = np.random.default_rng(42)
        samples = (rng.random(16000 * 4) * 2 - 1).astype(np.float32)
        pcm16 = (samples * 32767).astype(np.int16).tobytes()
        mgr.add_audio(0, pcm16)
        voice_after_lock = mgr.get_voice_id(0)
        # Add more audio — voice should not change
        mgr.add_audio(0, pcm16)
        assert mgr.get_voice_id(0) == voice_after_lock

    def test_mark_utterance_sent(self):
        mgr, _ = self._make_manager()
        mgr.get_voice_id(0)
        assert mgr._speakers[0].utterances_sent == 0
        mgr.mark_utterance_sent(0)
        assert mgr._speakers[0].utterances_sent == 1

    def test_playback_started_flag(self):
        mgr, _ = self._make_manager()
        assert mgr.playback_started is False
        mgr.mark_playback_started()
        assert mgr.playback_started is True

    def test_cleanup(self, event_loop):
        mgr, _ = self._make_manager()
        mgr.get_voice_id(0)
        mgr.get_voice_id(1)
        event_loop.run_until_complete(mgr.cleanup())
        assert len(mgr._speakers) == 0


class TestWaitForAnalysis:
    def test_wait_completes_when_already_analyzed(self):
        mgr, _ = TestSpeakerManager()._make_manager()
        mgr.get_voice_id(0)
        import numpy as np

        rng = np.random.default_rng(42)
        samples = (rng.random(16000 * 4) * 2 - 1).astype(np.float32)
        pcm16 = (samples * 32767).astype(np.int16).tobytes()
        mgr.add_audio(0, pcm16)

        loop = asyncio.new_event_loop()
        result = loop.run_until_complete(mgr.wait_for_analysis(0, timeout=1.0))
        loop.close()
        assert result is True

    def test_wait_times_out_with_insufficient_audio(self):
        mgr, _ = TestSpeakerManager()._make_manager()
        mgr.get_voice_id(0)
        # Add only 0.5s of audio — not enough for analysis
        pcm = b"\x00\x01" * (16000 // 2)
        mgr.add_audio(0, pcm)

        loop = asyncio.new_event_loop()
        result = loop.run_until_complete(mgr.wait_for_analysis(0, timeout=0.5))
        loop.close()
        # Should timeout but still lock the voice
        assert result is False
        assert mgr._speakers[0].is_locked is True
