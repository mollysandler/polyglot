# tests/conftest.py
import sys
import types
import io
import wave
from dataclasses import dataclass

import numpy as np

# ═══════════════════════════════════════════════════════════════════════════════
# Stub out heavy dependencies BEFORE any test imports main.py.
# We try real imports first; stubs are only installed when the real package
# is NOT available (e.g. running outside the full venv).
# ═══════════════════════════════════════════════════════════════════════════════

def _can_import(name: str) -> bool:
    """Check if a module can actually be imported (not just present as a stub)."""
    try:
        __import__(name)
        return True
    except (ImportError, ModuleNotFoundError):
        return False


# --- torch ---
if not _can_import("torch"):
    _torch = types.ModuleType("torch")

    class _FakeTensor:
        """Minimal tensor stub for type hints and basic usage."""
        def __init__(self, *args, **kwargs):
            pass
        def shape(self):
            return (1, 16000)
        def squeeze(self, *a):
            return self
        def numpy(self):
            return np.zeros(16000, dtype=np.float32)
        def mean(self, *a, **k):
            return self
        def __getitem__(self, key):
            return self
        def to(self, *a, **k):
            return self
        def float(self):
            return self
        def detach(self):
            return self
        def cpu(self):
            return self

    _torch.Tensor = _FakeTensor
    _torch.zeros = lambda *a, **k: _FakeTensor()
    _torch.randn = lambda *a, **k: _FakeTensor()
    _torch.cat = lambda tensors, dim=0: _FakeTensor()
    _torch.mean = lambda *a, **k: _FakeTensor()

    class _FakeDevice:
        def __init__(self, *a, **k):
            pass
    _torch.device = _FakeDevice

    class _FakeMPS:
        @staticmethod
        def is_available():
            return False

    class _FakeCUDA:
        @staticmethod
        def is_available():
            return False

    class _FakeBackends:
        mps = _FakeMPS()
    _torch.backends = _FakeBackends()
    _torch.cuda = _FakeCUDA()

    _torch.no_grad = lambda: types.SimpleNamespace(
        __enter__=lambda s: s, __exit__=lambda s, *a: None
    )

    sys.modules["torch"] = _torch

# --- torchaudio ---
if not _can_import("torchaudio"):
    _torchaudio = types.ModuleType("torchaudio")
    _torchaudio.load = lambda path: (None, 16000)

    _transforms = types.ModuleType("torchaudio.transforms")
    class _FakeResample:
        def __init__(self, *a, **k):
            pass
        def __call__(self, x):
            return x
    _transforms.Resample = _FakeResample
    _torchaudio.transforms = _transforms

    sys.modules["torchaudio"] = _torchaudio
    sys.modules["torchaudio.transforms"] = _transforms

# --- librosa ---
if not _can_import("librosa"):
    _librosa = types.ModuleType("librosa")
    _librosa.yin = lambda *a, **k: np.array([150.0])
    _librosa_effects = types.ModuleType("librosa.effects")
    _librosa_effects.preemphasis = lambda x, **k: x
    _librosa_effects.time_stretch = lambda y, rate=1.0: y
    _librosa.effects = _librosa_effects

    sys.modules["librosa"] = _librosa
    sys.modules["librosa.effects"] = _librosa_effects

# --- huggingface_hub ---
if not _can_import("huggingface_hub"):
    _hf = types.ModuleType("huggingface_hub")
    _hf.snapshot_download = lambda *a, **k: "/tmp/fake_model"
    _hf.login = lambda **k: None
    sys.modules["huggingface_hub"] = _hf

# --- qwen_tts ---
if not _can_import("qwen_tts"):
    _qwen = types.ModuleType("qwen_tts")
    class _FakeQwenModel:
        def __init__(self, *a, **k):
            pass
    _qwen.Qwen3TTSModel = _FakeQwenModel
    sys.modules["qwen_tts"] = _qwen

# --- diarizer (fake module stub) ---
fake_diarizer = types.ModuleType("diarizer")


@dataclass
class SpeakerSegment:
    speaker_id: str
    start_ms: int
    end_ms: int
    start_sec: float
    end_sec: float

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


class SpeakerDiarizer:
    """Test stub. Real implementation lives in diarizer.py."""
    pass


class SportsDiarizer(SpeakerDiarizer):
    """Test stub for SportsDiarizer."""
    pass


fake_diarizer.SpeakerSegment = SpeakerSegment
fake_diarizer.SpeakerDiarizer = SpeakerDiarizer
fake_diarizer.SportsDiarizer = SportsDiarizer

# Only install the stub if the real module isn't already imported
sys.modules.setdefault("diarizer", fake_diarizer)


# ═══════════════════════════════════════════════════════════════════════════════
# Shared test helpers
# ═══════════════════════════════════════════════════════════════════════════════

def seg(speaker: str, start_ms: int, end_ms: int) -> SpeakerSegment:
    """Factory for SpeakerSegment with auto-computed sec fields."""
    return SpeakerSegment(
        speaker_id=speaker,
        start_ms=start_ms,
        end_ms=end_ms,
        start_sec=start_ms / 1000.0,
        end_sec=end_ms / 1000.0,
    )


def make_wav_bytes(sr: int = 8000, seconds: float = 0.1, freq: float = 440.0, nch: int = 1) -> bytes:
    """Generate a valid PCM-16 WAV file in memory."""
    n = int(sr * seconds)
    t = np.arange(n, dtype=np.float32) / sr
    x = (0.2 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    pcm = (x * 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(nch)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        if nch == 2:
            interleaved = np.column_stack([pcm, pcm]).ravel().astype(np.int16)
            wf.writeframes(interleaved.tobytes())
        else:
            wf.writeframes(pcm.tobytes())
    return buf.getvalue()


# ═══════════════════════════════════════════════════════════════════════════════
# Autouse fixture: prevent heavy model/service init
# ═══════════════════════════════════════════════════════════════════════════════
import pytest


@pytest.fixture(autouse=True)
def _disable_heavy_initialization(monkeypatch):
    import main
    monkeypatch.setattr(main.DynamicSpeakerTranslator, "_initialize_services", lambda self: None)
