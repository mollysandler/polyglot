"""
Tests for DeepgramStream message-accumulation logic (BUG-026).

The bug was: every is_final=true message was treated as a complete utterance.
Deepgram actually emits multiple is_final=true segments per logical utterance;
the real "end of utterance" signal is speech_final=true (or UtteranceEnd).
Treating each is_final as its own utterance fragmented sentences mid-thought
and destroyed translation quality.

Fix: accumulate words across is_final events, flush only on speech_final,
UtteranceEnd, or MAX_ACCUMULATION_SEC safety timeout.
"""

from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

os.environ.setdefault("DEEPGRAM_API_KEY", "test-key")


# ---------------------------------------------------------------------------
# Helpers: build minimal message objects that quack like the Deepgram SDK types
# ---------------------------------------------------------------------------


def make_word(word, speaker, start, end, punctuated=None):
    return SimpleNamespace(
        word=word,
        punctuated_word=punctuated,
        speaker=speaker,
        start=start,
        end=end,
    )


def make_results(words, transcript=None, is_final=True, speech_final=False):
    """Build a mock ListenV1Results-like message."""
    transcript = (
        transcript if transcript is not None else " ".join(w.word for w in words)
    )
    alt = SimpleNamespace(transcript=transcript, words=words)
    channel = SimpleNamespace(alternatives=[alt])
    return SimpleNamespace(
        channel=channel,
        is_final=is_final,
        speech_final=speech_final,
    )


# ---------------------------------------------------------------------------
# Fresh stream factory — instantiates without connecting
# ---------------------------------------------------------------------------


def make_stream():
    """Build a DeepgramStream without connecting — for pure logic tests."""
    from deepgram_client import DeepgramStream

    emitted = []
    utt_end_calls = []
    stream = DeepgramStream(
        language="es",
        on_utterance=lambda u: emitted.append(u),
        on_utterance_end=lambda: utt_end_calls.append(True),
        api_key="test-key",
    )
    return stream, emitted, utt_end_calls


# ===========================================================================
# BUG-026 proof tests: accumulation across is_final until speech_final
# ===========================================================================


class TestAccumulation:
    def test_is_final_without_speech_final_does_not_emit(self):
        """Non-terminal is_final should accumulate, not flush."""
        stream, emitted, _ = make_stream()
        msg = make_results(
            [make_word("Hola", 0, 0.0, 0.5)],
            is_final=True,
            speech_final=False,
        )
        stream._handle_results(msg)
        assert emitted == []
        assert len(stream._pending_words) == 1

    def test_speech_final_triggers_emit(self):
        """is_final + speech_final flushes the accumulated utterance."""
        stream, emitted, _ = make_stream()
        msg = make_results(
            [make_word("Hola", 0, 0.0, 0.5)],
            is_final=True,
            speech_final=True,
        )
        stream._handle_results(msg)
        assert len(emitted) == 1
        assert emitted[0].text == "Hola"

    def test_multiple_is_finals_combined_into_one_utterance(self):
        """Several is_final segments accumulate and emit as ONE utterance on speech_final.

        This is the core scenario from the bad Spanish translation:
          "¿puedo entender"     (is_final, !speech_final)
          "o sea, me cuesta"    (is_final, !speech_final)
          "pero puedo llegar"   (is_final, speech_final)
        Should combine into "¿puedo entender o sea, me cuesta pero puedo llegar".
        """
        stream, emitted, _ = make_stream()

        stream._handle_results(
            make_results(
                [make_word("puedo", 0, 0.0, 0.3), make_word("entender", 0, 0.3, 0.7)],
                is_final=True,
                speech_final=False,
            )
        )
        assert emitted == []

        stream._handle_results(
            make_results(
                [
                    make_word("o", 0, 0.9, 1.0),
                    make_word("sea", 0, 1.0, 1.2),
                    make_word("me", 0, 1.2, 1.3),
                    make_word("cuesta", 0, 1.3, 1.7),
                ],
                is_final=True,
                speech_final=False,
            )
        )
        assert emitted == []

        stream._handle_results(
            make_results(
                [
                    make_word("pero", 0, 1.9, 2.1),
                    make_word("puedo", 0, 2.1, 2.3),
                    make_word("llegar", 0, 2.3, 2.7),
                ],
                is_final=True,
                speech_final=True,
            )
        )

        assert len(emitted) == 1
        assert emitted[0].text == "puedo entender o sea me cuesta pero puedo llegar"
        assert emitted[0].start_sec == pytest.approx(0.0)
        assert emitted[0].end_sec == pytest.approx(2.7)

    def test_interim_results_are_ignored(self):
        """is_final=false messages shouldn't accumulate or emit."""
        stream, emitted, _ = make_stream()
        msg = make_results(
            [make_word("Hola", 0, 0.0, 0.5)],
            is_final=False,
            speech_final=False,
        )
        stream._handle_results(msg)
        assert emitted == []
        assert stream._pending_words == []

    def test_empty_transcript_skipped(self):
        """Messages with empty transcripts short-circuit without accumulation."""
        stream, emitted, _ = make_stream()
        msg = make_results([], transcript="", is_final=True, speech_final=True)
        stream._handle_results(msg)
        assert emitted == []
        assert stream._pending_words == []


# ===========================================================================
# UtteranceEnd: flushes accumulated words when speech_final never came
# ===========================================================================


class TestUtteranceEnd:
    def test_utterance_end_flushes_pending(self):
        """If speech_final never fired, UtteranceEnd flushes accumulated words."""
        stream, emitted, utt_end_calls = make_stream()
        # Simulate accumulation without speech_final
        stream._handle_results(
            make_results(
                [make_word("Hola", 0, 0.0, 0.5)],
                is_final=True,
                speech_final=False,
            )
        )
        assert emitted == []

        # Backdate last_is_final_time so we don't hit the 0.15s guard
        stream._last_is_final_time = 0.0

        stream._handle_utterance_end()
        assert len(emitted) == 1
        assert emitted[0].text == "Hola"
        assert utt_end_calls == [True]

    def test_utterance_end_suppressed_right_after_speech_final(self):
        """If speech_final just fired, UtteranceEnd should not re-emit."""

        stream, emitted, _ = make_stream()

        # Flush via speech_final
        stream._handle_results(
            make_results(
                [make_word("Hola", 0, 0.0, 0.5)],
                is_final=True,
                speech_final=True,
            )
        )
        assert len(emitted) == 1

        # Immediately after, UtteranceEnd fires — should not re-emit
        stream._handle_utterance_end()
        assert len(emitted) == 1  # no new utterance

    def test_utterance_end_with_no_pending_fires_callback_only(self):
        """UtteranceEnd with nothing buffered still calls on_utterance_end."""
        stream, emitted, utt_end_calls = make_stream()
        stream._last_is_final_time = 0.0
        stream._handle_utterance_end()
        assert emitted == []
        assert utt_end_calls == [True]


# ===========================================================================
# Safety timeout: prevents indefinite buffering if speech_final never comes
# ===========================================================================


class TestAccumulationTimeout:
    def test_timeout_force_flushes(self, monkeypatch):
        """After MAX_ACCUMULATION_SEC, an is_final flushes even without speech_final."""
        import deepgram_client

        stream, emitted, _ = make_stream()

        # First is_final at t=0
        mock_time = [100.0]
        monkeypatch.setattr("time.monotonic", lambda: mock_time[0])

        stream._handle_results(
            make_results(
                [make_word("A", 0, 0.0, 0.5)],
                is_final=True,
                speech_final=False,
            )
        )
        assert emitted == []

        # Advance past MAX_ACCUMULATION_SEC (5s default)
        mock_time[0] = 100.0 + deepgram_client.MAX_ACCUMULATION_SEC + 0.1

        stream._handle_results(
            make_results(
                [make_word("B", 0, 5.1, 5.5)],
                is_final=True,
                speech_final=False,
            )
        )
        # Should have flushed both words
        assert len(emitted) == 1
        assert emitted[0].text == "A B"


# ===========================================================================
# Multi-speaker handling (unchanged by BUG-026 but useful regression coverage)
# ===========================================================================


class TestSpeakerSplit:
    def test_speaker_change_within_one_utterance_emits_multiple(self):
        """When accumulated words span multiple speakers, emit one utterance per run."""
        stream, emitted, _ = make_stream()
        stream._handle_results(
            make_results(
                [
                    make_word("Hola", 0, 0.0, 0.5),
                    make_word("que", 0, 0.5, 0.8),
                    make_word("tal", 1, 1.0, 1.3),  # speaker change
                    make_word("bien", 1, 1.3, 1.6),
                ],
                is_final=True,
                speech_final=True,
            )
        )
        assert len(emitted) == 2
        assert emitted[0].speaker_id == 0
        assert emitted[0].text == "Hola que"
        assert emitted[1].speaker_id == 1
        assert emitted[1].text == "tal bien"


# ===========================================================================
# utterance_end_ms default bumped 1500 → 2000 for better conversational flow
# ===========================================================================


class TestDefaults:
    def test_default_utterance_end_ms_is_2000(self):
        from deepgram_client import DeepgramStream

        s = DeepgramStream(api_key="test-key")
        assert s._utterance_end_ms == 2000
