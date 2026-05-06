"""Tests for streaming_server.py WebSocket endpoint."""

import json
import pytest


class TestWSEndpointParsing:
    """Test message parsing logic without a real WebSocket."""

    def test_decode_config_msg(self):
        from protocol import decode_client_msg
        data = decode_client_msg('{"type":"config","source_lang":"en","target_lang":"hi"}')
        assert data["type"] == "config"
        assert data["source_lang"] == "en"
        assert data["target_lang"] == "hi"

    def test_decode_heartbeat(self):
        from protocol import decode_client_msg
        data = decode_client_msg('{"type":"heartbeat"}')
        assert data["type"] == "heartbeat"

    def test_decode_video_position(self):
        from protocol import decode_client_msg
        data = decode_client_msg('{"type":"video_position","time_sec":45.2}')
        assert data["type"] == "video_position"
        assert data["time_sec"] == 45.2

    def test_decode_end_stream(self):
        from protocol import decode_client_msg
        data = decode_client_msg('{"type":"end_stream"}')
        assert data["type"] == "end_stream"


class TestSessionReadyMsg:
    def test_session_ready_format(self):
        from protocol import SessionReadyMsg, encode_msg
        msg = SessionReadyMsg(session_id="test-123")
        raw = encode_msg(msg)
        data = json.loads(raw)
        assert data == {"type": "session_ready", "session_id": "test-123"}


class TestHealthEndpoint:
    """Test the /health endpoint."""

    @pytest.fixture
    def client(self):
        from starlette.testclient import TestClient
        from streaming_server import app
        return TestClient(app)

    def test_health(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}
