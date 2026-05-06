"""Tests for protocol.py message types and helpers."""

import json
import pytest
from protocol import (
    SessionReadyMsg, UtteranceStartMsg, UtteranceEndMsg, CaptionMsg,
    ErrorMsg, Utterance, encode_msg, decode_client_msg,
    AUDIO_SAMPLE_RATE, AUDIO_FRAME_BYTES, TARGET_BUFFER_SEC,
)


class TestConstants:
    def test_audio_frame_bytes(self):
        # 16kHz * 2 bytes * 0.2s = 6400
        assert AUDIO_FRAME_BYTES == 6400

    def test_sample_rate(self):
        assert AUDIO_SAMPLE_RATE == 16000

    def test_buffer_target(self):
        assert TARGET_BUFFER_SEC == 30


class TestEncodeMsg:
    def test_session_ready(self):
        msg = SessionReadyMsg(session_id="abc-123")
        raw = encode_msg(msg)
        data = json.loads(raw)
        assert data["type"] == "session_ready"
        assert data["session_id"] == "abc-123"

    def test_utterance_start(self):
        msg = UtteranceStartMsg(seq=1, speaker_id=0)
        data = json.loads(encode_msg(msg))
        assert data["type"] == "utterance_start"
        assert data["seq"] == 1
        assert data["speaker_id"] == 0
        assert data["format"] == "mp3"

    def test_utterance_end(self):
        msg = UtteranceEndMsg(seq=5, duration_sec=2.3)
        data = json.loads(encode_msg(msg))
        assert data["type"] == "utterance_end"
        assert data["duration_sec"] == 2.3

    def test_caption(self):
        msg = CaptionMsg(
            seq=1, speaker_id=0,
            original="Hello", translated="Hola",
            start_time_sec=1.0, end_time_sec=2.0,
        )
        data = json.loads(encode_msg(msg))
        assert data["original"] == "Hello"
        assert data["translated"] == "Hola"

    def test_error(self):
        msg = ErrorMsg(message="something broke", recoverable=False)
        data = json.loads(encode_msg(msg))
        assert data["type"] == "error"
        assert data["recoverable"] is False


class TestDecodeClientMsg:
    def test_config(self):
        raw = '{"type": "config", "source_lang": "en", "target_lang": "es"}'
        data = decode_client_msg(raw)
        assert data["type"] == "config"
        assert data["source_lang"] == "en"

    def test_heartbeat(self):
        data = decode_client_msg('{"type": "heartbeat"}')
        assert data["type"] == "heartbeat"

    def test_invalid_json(self):
        with pytest.raises(json.JSONDecodeError):
            decode_client_msg("not json")


class TestUtterance:
    def test_fields(self):
        u = Utterance(text="Goal!", speaker_id=1, start_sec=10.5, end_sec=11.2)
        assert u.text == "Goal!"
        assert u.speaker_id == 1
        assert u.channel == 0  # default
