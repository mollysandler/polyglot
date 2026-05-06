"""
WebSocket message protocol for the streaming translation pipeline.

Defines all message types exchanged between:
  Chrome extension <-> Backend <-> Deepgram / ElevenLabs
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

AUDIO_SAMPLE_RATE = 16000  # Hz – PCM input from extension
AUDIO_FRAME_DURATION_MS = 200  # ms per binary frame from extension
AUDIO_FRAME_BYTES = AUDIO_SAMPLE_RATE * 2 * AUDIO_FRAME_DURATION_MS // 1000  # 6400
TARGET_BUFFER_SEC = 30  # seconds of translated audio before playback
FALLBACK_BUFFER_SEC = 45  # start playback regardless after this many seconds
DEEPGRAM_UTTERANCE_END_MS = 1500  # silence gap to finalize an utterance
VOICE_ANALYSIS_SEC = 3.0  # seconds of audio needed for pitch/gender analysis
MAX_CONCURRENT_UTTERANCES = 3  # parallel utterance processing
TTS_IDLE_TIMEOUT_SEC = 30  # close idle TTS WebSocket connections
HEARTBEAT_INTERVAL_SEC = 25  # keepalive from extension
DRIFT_POLL_INTERVAL_SEC = 2  # video position polling interval


# ---------------------------------------------------------------------------
# Client -> Server messages (JSON text frames)
# ---------------------------------------------------------------------------


@dataclass
class ConfigMsg:
    source_lang: str
    target_lang: str
    type: str = "config"


@dataclass
class HeartbeatMsg:
    type: str = "heartbeat"


@dataclass
class VideoPositionMsg:
    time_sec: float
    type: str = "video_position"


@dataclass
class EndStreamMsg:
    type: str = "end_stream"


# ---------------------------------------------------------------------------
# Server -> Client messages (JSON text frames)
# ---------------------------------------------------------------------------


@dataclass
class SessionReadyMsg:
    session_id: str
    type: str = "session_ready"


@dataclass
class UtteranceStartMsg:
    seq: int
    speaker_id: int
    format: str = "mp3"
    type: str = "utterance_start"


@dataclass
class UtteranceEndMsg:
    seq: int
    duration_sec: float
    original_start_sec: float = 0.0
    original_end_sec: float = 0.0
    type: str = "utterance_end"


@dataclass
class CaptionMsg:
    seq: int
    speaker_id: int
    original: str
    translated: str
    start_time_sec: float
    end_time_sec: float
    type: str = "caption"


@dataclass
class RebufferStartMsg:
    speaker_id: int
    reason: str = "new_speaker"
    type: str = "rebuffer_start"


@dataclass
class RebufferProgressMsg:
    speaker_id: int
    progress: int = 0
    type: str = "rebuffer_progress"


@dataclass
class RebufferEndMsg:
    speaker_id: int
    type: str = "rebuffer_end"


@dataclass
class ErrorMsg:
    message: str
    recoverable: bool = True
    type: str = "error"


@dataclass
class HeartbeatAckMsg:
    type: str = "heartbeat_ack"


# ---------------------------------------------------------------------------
# Internal data types
# ---------------------------------------------------------------------------


@dataclass
class Utterance:
    """A finalized transcript utterance from Deepgram."""

    text: str
    speaker_id: int
    start_sec: float
    end_sec: float
    channel: int = 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def encode_msg(msg) -> str:
    """Serialize a dataclass message to JSON string."""
    return json.dumps(asdict(msg))


def decode_client_msg(raw: str) -> dict:
    """Parse a JSON text frame from the client."""
    return json.loads(raw)
