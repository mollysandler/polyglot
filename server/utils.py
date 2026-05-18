from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np


# -------------------------
# Audio feature helpers
# -------------------------


def estimate_pitch_yin(y: np.ndarray, sr: int) -> Optional[float]:
    """
    Median F0 estimate via autocorrelation (pure numpy — no numba/librosa.yin).
    Safe in GPU containers where numba can SIGSEGV.
    """
    y = y.astype(np.float32)
    fmin, fmax = 70.0, 300.0
    min_lag = max(1, int(sr / fmax))
    max_lag = min(len(y) - 1, int(sr / fmin))
    frame_len = min(int(sr * 0.025), len(y))
    hop_len = max(1, int(sr * 0.010))
    pitches = []
    for start in range(0, max(1, len(y) - frame_len + 1), hop_len):
        frame = y[start: start + frame_len]
        if np.max(np.abs(frame)) < 1e-4:
            continue
        corr = np.correlate(frame, frame, mode="full")
        corr = corr[len(corr) // 2:]
        if max_lag >= len(corr):
            continue
        seg = corr[min_lag: max_lag + 1]
        if len(seg) == 0 or seg.max() <= 0:
            continue
        peak_lag = int(np.argmax(seg)) + min_lag
        pitches.append(float(sr) / peak_lag)
    if not pitches:
        return None
    return float(np.median(pitches))


def gender_from_pitch(pitch_hz: Optional[float], pitch_range_hz: Optional[float] = None) -> str:
    """Very simple heuristic used only for choosing a pleasant stock voice."""
    if pitch_hz is None:
        return "unknown"
    if pitch_hz < 160:
        return "male"
    if pitch_hz > 180:
        return "female"
    return "unknown"


# -------------------------
# Configuration objects
# -------------------------


@dataclass(frozen=True)
class TTSConfig:
    """TTS/voice-cloning knobs (formerly env vars)."""

    # Kept for compatibility / future switching logic
    tts_backend: str = "qwen"

    qwen_enable: bool = True
    qwen_model_id: str = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
    qwen_device: str = "cpu"

    xtts_enable: bool = True
    xtts_model_id: str = "tts_models/multilingual/multi-dataset/xtts_v2"
    xtts_device: str = "cpu"

    # Voice-clone reference audio requirements
    clone_ref_target_sec: float = 15.0  # target seconds to collect per speaker
    clone_ref_min_sec: float = 6.0      # minimum seconds required to attempt Qwen/XTTS


@dataclass(frozen=True)
class SpeakerMergeConfig:
    """Speaker post-merge knobs (formerly env vars)."""

    merge_enable: bool = True
    merge_sim: float = 0.74
    tiny_total_ms: int = 6000
    emb_min_chunk_ms: int = 250
    merge_ref_sec: float = 20.0

    # Optional: if not provided we default to (merge_sim - 0.20)
    absorb_sim: Optional[float] = None

    def resolved_absorb_sim(self) -> float:
        return float(self.absorb_sim if self.absorb_sim is not None else (self.merge_sim - 0.20))
