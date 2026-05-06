"""Tests for voice_catalog.py and tts_client.py facade."""

from voice_catalog import (
    VoiceMatcher,
    ELEVENLABS_VOICES,
    OPENAI_VOICES,
    CARTESIA_VOICES,
)


class TestVoiceCatalogs:
    def test_elevenlabs_catalog_has_both_genders(self):
        males = [v for v in ELEVENLABS_VOICES if v.gender == "male"]
        females = [v for v in ELEVENLABS_VOICES if v.gender == "female"]
        assert len(males) >= 10
        assert len(females) >= 5

    def test_openai_catalog_complete(self):
        assert len(OPENAI_VOICES) == 13

    def test_cartesia_catalog_has_both_genders(self):
        males = [v for v in CARTESIA_VOICES if v.gender == "male"]
        females = [v for v in CARTESIA_VOICES if v.gender == "female"]
        assert len(males) >= 10
        assert len(females) >= 5

    def test_all_entries_have_required_fields(self):
        for catalog in [ELEVENLABS_VOICES, OPENAI_VOICES, CARTESIA_VOICES]:
            for entry in catalog:
                assert entry.voice_id
                assert entry.provider
                assert entry.gender in ("male", "female")
                assert entry.pitch_category in (
                    "low",
                    "medium_low",
                    "medium",
                    "medium_high",
                    "high",
                )
                assert entry.style
                assert entry.display_name

    def test_no_duplicate_voice_ids_per_provider(self):
        for catalog in [ELEVENLABS_VOICES, OPENAI_VOICES, CARTESIA_VOICES]:
            ids = [v.voice_id for v in catalog]
            assert len(ids) == len(set(ids)), "Duplicate voice_id in catalog"


class TestVoiceMatcher:
    def test_match_respects_gender(self):
        matcher = VoiceMatcher("elevenlabs")
        entry = matcher.match_voice(gender="female", avg_pitch=200.0)
        assert entry.gender == "female"

    def test_match_male_low_pitch(self):
        matcher = VoiceMatcher("elevenlabs")
        entry = matcher.match_voice(gender="male", avg_pitch=100.0)
        assert entry.gender == "male"
        assert entry.pitch_category in ("low", "medium_low")

    def test_match_avoids_reuse(self):
        matcher = VoiceMatcher("elevenlabs")
        e1 = matcher.match_voice(gender="male", avg_pitch=150.0)
        matcher.lock_voice(0, e1)
        e2 = matcher.match_voice(gender="male", avg_pitch=150.0)
        assert e1.voice_id != e2.voice_id

    def test_lock_and_retrieve(self):
        matcher = VoiceMatcher("elevenlabs")
        entry = matcher.match_voice(gender="male", avg_pitch=150.0)
        assert matcher.get_locked_voice(0) is None
        matcher.lock_voice(0, entry)
        assert matcher.get_locked_voice(0) == entry
        assert matcher.is_locked(0) is True

    def test_energetic_preference(self):
        matcher = VoiceMatcher("elevenlabs")
        entry = matcher.match_voice(gender="male", avg_pitch=160.0, energy=0.9)
        # Should prefer an energetic style
        assert (
            "energetic" in entry.style
            or "excited" in entry.style
            or "shouty" in entry.style
        )

    def test_calm_preference(self):
        matcher = VoiceMatcher("elevenlabs")
        entry = matcher.match_voice(gender="male", avg_pitch=130.0, energy=0.1)
        assert "calm" in entry.style or "deep" in entry.style

    def test_reset_clears_state(self):
        matcher = VoiceMatcher("elevenlabs")
        entry = matcher.match_voice(gender="male", avg_pitch=150.0)
        matcher.lock_voice(0, entry)
        matcher.reset()
        assert matcher.get_locked_voice(0) is None
        assert matcher.is_locked(0) is False

    def test_openai_provider(self):
        matcher = VoiceMatcher("openai")
        entry = matcher.match_voice(gender="male", avg_pitch=120.0)
        assert entry.provider == "openai"

    def test_cartesia_provider(self):
        matcher = VoiceMatcher("cartesia")
        entry = matcher.match_voice(gender="female", avg_pitch=200.0)
        assert entry.provider == "cartesia"

    def test_exhausted_voices_allows_reuse(self):
        matcher = VoiceMatcher("openai")  # only 13 voices
        # Lock all male voices
        for i in range(20):
            entry = matcher.match_voice(gender="male", avg_pitch=150.0)
            matcher.lock_voice(i, entry)
        # Should still return a voice even when all are used
        entry = matcher.match_voice(gender="male", avg_pitch=150.0)
        assert entry is not None
        assert entry.voice_id
