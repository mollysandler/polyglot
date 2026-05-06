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


def find_silence_split(
    samples: np.ndarray,
    sr: int,
    min_chunk_samples: int,
    max_chunk_samples: int,
    window_ms: int = 30,
    consecutive: int = 4,
    rms_threshold: float = 0.02,
) -> int:
    """Scan backwards from max_chunk_samples toward min_chunk_samples looking
    for consecutive low-energy windows (~120ms of silence).

    Two-pass approach:
      1. Strict: find ``consecutive`` windows all below ``rms_threshold``.
      2. Fallback: if no strict silence found, return the position of the
         lowest-energy window in the scan range (the "least bad" split).

    Returns the sample index of the split point.  Only returns -1 if the
    buffer is shorter than min_chunk_samples.
    """
    window_samples = int(sr * window_ms / 1000)
    end = min(len(samples), max_chunk_samples)
    scan_start = min_chunk_samples

    if end - window_samples * consecutive < scan_start:
        return -1

    # Pre-compute RMS for every window in the scan range to avoid redundant work
    first_window_pos = scan_start
    last_window_pos = end - window_samples
    n_windows = (last_window_pos - first_window_pos) // window_samples + 1
    if n_windows <= 0:
        return -1

    rms_values = np.empty(n_windows, dtype=np.float32)
    for i in range(n_windows):
        w_start = first_window_pos + i * window_samples
        w_end = w_start + window_samples
        window = samples[w_start:w_end]
        rms_values[i] = float(np.sqrt(np.mean(window ** 2)))

    # Pass 1: scan backwards for `consecutive` windows all below threshold
    for i in range(n_windows - consecutive, -1, -1):
        if np.all(rms_values[i:i + consecutive] < rms_threshold):
            return first_window_pos + i * window_samples

    # Pass 2: find the quietest single window (least-bad split point)
    # Use a sliding average over `consecutive` windows for smoother selection
    if n_windows >= consecutive:
        avg_rms = np.convolve(rms_values, np.ones(consecutive) / consecutive, mode='valid')
        best_i = int(np.argmin(avg_rms))
        return first_window_pos + best_i * window_samples
    else:
        best_i = int(np.argmin(rms_values))
        return first_window_pos + best_i * window_samples


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
