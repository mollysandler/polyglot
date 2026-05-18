"""Tests for protocol.py message types and helpers."""

import json
import pytest
from protocol import (
    ConfigMsg, HeartbeatMsg, VideoPositionMsg, EndStreamMsg,
    SessionReadyMsg, UtteranceStartMsg, UtteranceEndMsg, CaptionMsg,
    RebufferStartMsg, RebufferProgressMsg, RebufferEndMsg,
    ErrorMsg, HeartbeatAckMsg, Utterance, encode_msg, decode_client_msg,
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


class TestRebufferMessages:
    """Speaker-driven rebuffering is its own short pause in playback. The
    side panel listens for all three messages to drive its 'buffering' UI."""

    def test_rebuffer_start_defaults_to_new_speaker(self):
        data = json.loads(encode_msg(RebufferStartMsg(speaker_id=2)))
        assert data["type"] == "rebuffer_start"
        assert data["speaker_id"] == 2
        assert data["reason"] == "new_speaker"

    def test_rebuffer_progress_percentage(self):
        data = json.loads(encode_msg(RebufferProgressMsg(speaker_id=3, progress=42)))
        assert data["type"] == "rebuffer_progress"
        assert data["speaker_id"] == 3
        assert data["progress"] == 42

    def test_rebuffer_end_carries_speaker_id(self):
        data = json.loads(encode_msg(RebufferEndMsg(speaker_id=7)))
        assert data["type"] == "rebuffer_end"
        assert data["speaker_id"] == 7

    def test_start_progress_end_share_speaker_id(self):
        # The side panel only correlates these by speaker_id; if the field
        # changed name or type the three messages would drift apart.
        sid = 11
        for cls in (RebufferStartMsg, RebufferProgressMsg, RebufferEndMsg):
            data = json.loads(encode_msg(cls(speaker_id=sid)))
            assert data["speaker_id"] == sid


class TestHeartbeat:
    def test_heartbeat_msg_serializes(self):
        data = json.loads(encode_msg(HeartbeatMsg()))
        assert data == {"type": "heartbeat"}

    def test_heartbeat_ack_serializes(self):
        data = json.loads(encode_msg(HeartbeatAckMsg()))
        assert data == {"type": "heartbeat_ack"}


class TestClientMessageEncoding:
    """Client-bound dataclasses are usually decoded server-side, but they
    must also serialize cleanly for tests, replay tools, and Modal logs."""

    def test_config_msg(self):
        data = json.loads(encode_msg(ConfigMsg(source_lang="en", target_lang="fr")))
        assert data["type"] == "config"
        assert data["source_lang"] == "en"
        assert data["target_lang"] == "fr"

    def test_video_position_msg(self):
        data = json.loads(encode_msg(VideoPositionMsg(time_sec=42.5)))
        assert data["type"] == "video_position"
        assert data["time_sec"] == 42.5

    def test_end_stream_msg(self):
        data = json.loads(encode_msg(EndStreamMsg()))
        assert data == {"type": "end_stream"}


class TestUtteranceEndOriginalTimes:
    """original_start_sec / original_end_sec were added so the extension can
    align translated chunks against the source video timeline (used for
    canvas-overlay sync). Default to 0.0 for back-compat."""

    def test_defaults_to_zero(self):
        data = json.loads(encode_msg(UtteranceEndMsg(seq=1, duration_sec=1.5)))
        assert data["original_start_sec"] == 0.0
        assert data["original_end_sec"] == 0.0

    def test_round_trip_preserves_floats(self):
        msg = UtteranceEndMsg(
            seq=42, duration_sec=2.1,
            original_start_sec=10.123, original_end_sec=12.456,
        )
        data = json.loads(encode_msg(msg))
        assert data["original_start_sec"] == 10.123
        assert data["original_end_sec"] == 12.456


class TestRoundTrip:
    """encode_msg + decode_client_msg (json.loads) round-trips every
    message type without losing fields or coercing types."""

    @pytest.mark.parametrize("msg", [
        SessionReadyMsg(session_id="s-1"),
        UtteranceStartMsg(seq=1, speaker_id=0),
        UtteranceEndMsg(seq=1, duration_sec=1.5, original_start_sec=1.0, original_end_sec=2.5),
        CaptionMsg(seq=1, speaker_id=0, original="hi", translated="hola",
                   start_time_sec=0.0, end_time_sec=1.0),
        RebufferStartMsg(speaker_id=1),
        RebufferProgressMsg(speaker_id=1, progress=50),
        RebufferEndMsg(speaker_id=1),
        ErrorMsg(message="boom"),
        HeartbeatAckMsg(),
        ConfigMsg(source_lang="en", target_lang="es"),
        HeartbeatMsg(),
        VideoPositionMsg(time_sec=5.5),
        EndStreamMsg(),
    ])
    def test_round_trip(self, msg):
        from dataclasses import asdict
        encoded = encode_msg(msg)
        decoded = decode_client_msg(encoded)
        assert decoded == asdict(msg)
        # Every message must carry a "type" discriminator — the extension
        # routes on it.
        assert "type" in decoded
        assert decoded["type"] == msg.type
