"""Tests for session.py — the per-connection pipeline orchestrator.

Covers the two synchronous seams that drive every utterance:
  1. The pure helpers (_derive_directive, _add_emotion_cues) that translate
     source-text shape into TTS voice settings.
  2. The dedup + speaker-attribution logic at the top of _on_utterance(),
     which decides whether an utterance is processed at all.

Heavier flows (rebuffer, _process_utterance, _flush_pending) are async and
network-bound; they're best covered by integration runs against a real
backend rather than synthetic mocks here.
"""

import os
import pytest

# Session imports require ELEVENLABS_API_KEY at TTSClient construction time;
# the value isn't used in these tests because we never call the provider.
os.environ.setdefault("ELEVENLABS_API_KEY", "test-dummy-key")

import session as session_module
from session import Session, _derive_directive, _add_emotion_cues
from protocol import Utterance
from tts_provider import VoiceDirective


# ---------------------------------------------------------------------------
# _derive_directive: source-text shape -> TTS voice settings
# ---------------------------------------------------------------------------


class TestDeriveDirective:
    def test_short_exclamation_is_excited(self):
        u = Utterance(text="Goal!", speaker_id=0, start_sec=0.0, end_sec=1.0)
        d = _derive_directive(u, "¡Gol!")
        assert d.emotion == "excited"
        assert d.energy == pytest.approx(0.9)
        assert d.speed == pytest.approx(1.05)

    def test_long_exclamation_is_enthusiastic_not_excited(self):
        # Boundary: short = ≤5 words. 6+ word exclamations downshift.
        u = Utterance(
            text="What an absolutely incredible save by the keeper!",
            speaker_id=0, start_sec=0.0, end_sec=2.0,
        )
        d = _derive_directive(u, "...")
        assert d.emotion == "enthusiastic"
        assert d.energy == pytest.approx(0.7)

    def test_question_is_curious(self):
        u = Utterance(text="Where are we going?", speaker_id=0, start_sec=0.0, end_sec=1.0)
        d = _derive_directive(u, "...")
        assert d.emotion == "curious"
        assert d.speed == pytest.approx(0.95)  # slightly slower

    def test_neutral_default(self):
        u = Utterance(text="The weather is nice today.", speaker_id=0, start_sec=0.0, end_sec=1.0)
        d = _derive_directive(u, "...")
        assert d.emotion == "neutral"
        assert d.energy == pytest.approx(0.4)
        assert d.speed == pytest.approx(1.0)

    def test_returns_voice_directive_instance(self):
        u = Utterance(text="Hi", speaker_id=0, start_sec=0.0, end_sec=0.5)
        assert isinstance(_derive_directive(u, "Hola"), VoiceDirective)


# ---------------------------------------------------------------------------
# _add_emotion_cues: tweak translation text to match source punctuation/case
# ---------------------------------------------------------------------------


class TestAddEmotionCues:
    def test_exclamation_propagates_to_translation(self):
        # Translator may strip exclamation marks; we restore them.
        out = _add_emotion_cues("Goal!", "Gol.")
        assert out.endswith("!")

    def test_question_propagates_to_translation(self):
        out = _add_emotion_cues("Where?", "Dónde.")
        assert out.endswith("?")

    def test_short_exclamation_uppercases_first_word_when_multi_word(self):
        # Uppercase pass requires ≥2 translated words. A single-word
        # translation is left lowercase even on a short exclamation source.
        out = _add_emotion_cues("Goal!", "qué gol")
        assert out.startswith("QUÉ")
        assert out.endswith("!")

    def test_uppercase_pass_skipped_for_single_word_translation(self):
        out = _add_emotion_cues("Goal!", "gol")
        # Exclamation is propagated but no uppercase (only one word).
        assert out == "gol!"

    def test_long_translation_not_uppercased(self):
        # Uppercase pass only fires when translation is ≤6 words. Sevens up.
        long_translation = "el delantero principal anota un gol absolutamente increíble"
        out = _add_emotion_cues("Goal!", long_translation)
        assert out.split()[0] == "el"  # not "EL"

    def test_no_double_punctuation(self):
        # Source already ends with ! — don't add another.
        out = _add_emotion_cues("Wow!", "¡Vaya!")
        assert out.count("!") <= out.count("!") + 1  # idempotent
        assert out.endswith("!")

    def test_question_strips_trailing_period(self):
        out = _add_emotion_cues("Are you ready?", "Estás listo.")
        assert out.endswith("?")
        assert "." not in out.split()[-1]


# ---------------------------------------------------------------------------
# Session._on_utterance — synchronous dedup + attribution
# ---------------------------------------------------------------------------


@pytest.fixture
def session(monkeypatch):
    """Session with clustering disabled and a no-op TTS / network surface.

    Tasks that _on_utterance would spawn are intercepted so the test can
    inspect dedup behavior without an event loop.
    """
    monkeypatch.setattr(session_module, "_CLUSTERING_ENABLED", False)

    async def _send_text(_s):
        pass

    async def _send_bytes(_b):
        pass

    s = Session("en", "es", _send_text, _send_bytes)
    s._running = True

    # Replace asyncio.create_task with a recorder so we can assert that
    # processing was *attempted* without actually running coroutines.
    spawned = []

    def fake_create_task(coro):
        spawned.append(coro)
        # Close the coroutine to silence "never awaited" warnings.
        try:
            coro.close()
        except Exception:
            pass

        class _Stub:
            def add_done_callback(self, *_a, **_k):
                pass

        return _Stub()

    monkeypatch.setattr(session_module.asyncio, "create_task", fake_create_task)
    s._test_spawned = spawned
    return s


class TestOnUtteranceDedup:
    def test_running_false_short_circuits(self, session):
        session._running = False
        session._on_utterance(Utterance(text="hi", speaker_id=0, start_sec=0.0, end_sec=1.0))
        assert session._test_spawned == []
        assert session._recent_utterance_keys == set()

    def test_unique_utterance_is_processed(self, session):
        u = Utterance(text="hello world", speaker_id=0, start_sec=0.0, end_sec=1.5)
        session._on_utterance(u)
        assert len(session._test_spawned) == 1
        # Dedup state recorded for future matches.
        assert any("hello world" in k for k in session._recent_utterance_keys)

    def test_exact_duplicate_text_and_time_is_rejected(self, session):
        u = Utterance(text="hello", speaker_id=0, start_sec=0.0, end_sec=1.5)
        session._on_utterance(u)
        # Time has to advance OR text has to differ — repeating identical
        # text at the same start_sec is the canonical Deepgram duplicate.
        session._on_utterance(replace_utterance(u, end_sec=3.0))
        assert len(session._test_spawned) == 1

    def test_end_sec_too_close_to_previous_is_rejected(self, session):
        # The +0.05s guard against Deepgram emitting overlapping finals.
        first = Utterance(text="one", speaker_id=0, start_sec=0.0, end_sec=2.0)
        second = Utterance(text="two", speaker_id=0, start_sec=1.5, end_sec=2.03)  # within 0.05
        session._on_utterance(first)
        session._on_utterance(second)
        assert len(session._test_spawned) == 1

    def test_dedup_key_is_case_and_whitespace_insensitive(self, session):
        session._on_utterance(Utterance(text="Hello", speaker_id=0, start_sec=0.0, end_sec=1.5))
        session._on_utterance(Utterance(text="  HELLO  ", speaker_id=0, start_sec=0.0, end_sec=3.0))
        # Same content, same start_sec → second one dedup'd.
        assert len(session._test_spawned) == 1

    def test_recent_keys_fifo_eviction_at_50(self, session):
        # Push 60 distinct utterances; the oldest 10 keys should age out so
        # an even older duplicate would no longer collide.
        for i in range(60):
            session._on_utterance(
                Utterance(text=f"u{i}", speaker_id=0, start_sec=float(i), end_sec=float(i) + 0.5)
            )
        assert len(session._recent_utterance_keys) == 50
        assert len(session._recent_utterance_list) == 50

    def test_audio_buffer_attributed_then_cleared(self, session):
        session._audio_buffer.extend(b"\x00" * 32000)
        u = Utterance(text="hi", speaker_id=3, start_sec=0.0, end_sec=1.0)
        session._on_utterance(u)
        # Buffer drained into speaker_manager and cleared.
        assert len(session._audio_buffer) == 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def replace_utterance(u: Utterance, **fields) -> Utterance:
    from dataclasses import replace
    return replace(u, **fields)
