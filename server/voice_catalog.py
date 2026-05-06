"""
Voice catalog and matching for TTS providers.

Maintains a catalog of available voices per provider and a VoiceMatcher
that assigns the best-fitting voice based on speaker characteristics
(gender, pitch, energy). Voices are locked per speaker for session consistency.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Voice entry
# ---------------------------------------------------------------------------


@dataclass
class VoiceEntry:
    voice_id: str
    provider: str
    gender: str  # "male" or "female"
    pitch_category: str  # "low", "medium_low", "medium", "medium_high", "high"
    style: str  # descriptive label: "warm_calm", "energetic", etc.
    display_name: str


# ---------------------------------------------------------------------------
# Voice catalogs (static, per provider)
# ---------------------------------------------------------------------------

# ElevenLabs premade voices — expanded from the original 10 to 25
ELEVENLABS_VOICES: list[VoiceEntry] = [
    # --- Female voices ---
    VoiceEntry(
        "21m00Tcm4TlvDq8ikWAM", "elevenlabs", "female", "medium", "warm_calm", "Rachel"
    ),
    VoiceEntry(
        "AZnzlk1XvdvUeBnXmlld",
        "elevenlabs",
        "female",
        "medium_low",
        "strong_confident",
        "Domi",
    ),
    VoiceEntry(
        "EXAVITQu4vr4xnSDxMaL",
        "elevenlabs",
        "female",
        "medium_high",
        "soft_friendly",
        "Bella",
    ),
    VoiceEntry(
        "MF3mGyEYCl7XYWbV9V6O",
        "elevenlabs",
        "female",
        "medium",
        "emotional_expressive",
        "Elli",
    ),
    VoiceEntry(
        "jBpfAFnaylXpBRlo23rm",
        "elevenlabs",
        "female",
        "medium_high",
        "energetic",
        "Aria",
    ),
    VoiceEntry(
        "z9fAnlkpzviPz146aGWa",
        "elevenlabs",
        "female",
        "medium",
        "warm_narration",
        "Glinda",
    ),
    VoiceEntry(
        "XB0fDUnXU5powFXDhCwa",
        "elevenlabs",
        "female",
        "medium_low",
        "authoritative",
        "Charlotte",
    ),
    VoiceEntry(
        "pFZP5JQG7iQjIQuC4Bku",
        "elevenlabs",
        "female",
        "medium_high",
        "bright_cheerful",
        "Lily",
    ),
    VoiceEntry(
        "jsCqWAovK2LkecY7zXl4",
        "elevenlabs",
        "female",
        "medium",
        "warm_friendly",
        "Freya",
    ),
    VoiceEntry(
        "oWAxZDx7w5VEj9dCyTzz", "elevenlabs", "female", "low", "deep_warm", "Grace"
    ),
    # --- Male voices ---
    VoiceEntry(
        "ErXwobaYiN019PkySvjV", "elevenlabs", "male", "medium", "well_rounded", "Antoni"
    ),
    VoiceEntry(
        "TxGEqnHWrfWFTfGW9XjX",
        "elevenlabs",
        "male",
        "medium_low",
        "deep_authoritative",
        "Josh",
    ),
    VoiceEntry(
        "VR6AewLTigWG4xSOukaG", "elevenlabs", "male", "low", "crisp_strong", "Arnold"
    ),
    VoiceEntry(
        "pNInz6obpgDQGcFmaJgB", "elevenlabs", "male", "medium_low", "deep_calm", "Adam"
    ),
    VoiceEntry(
        "yoZ06aMxZJJ28mfd3POQ", "elevenlabs", "male", "medium", "energetic_young", "Sam"
    ),
    VoiceEntry(
        "IKne3meq5aSn9XLyUdCD",
        "elevenlabs",
        "male",
        "medium_high",
        "casual_conversational",
        "Charlie",
    ),
    VoiceEntry(
        "nPczCjzI2devNBz1zQrb",
        "elevenlabs",
        "male",
        "medium_low",
        "deep_narration",
        "Brian",
    ),
    VoiceEntry(
        "ODq5zmih8GrVes37Dizd",
        "elevenlabs",
        "male",
        "medium",
        "shouty_energetic",
        "Patrick",
    ),
    VoiceEntry(
        "pqHfZKP75CvOlQylNhV4",
        "elevenlabs",
        "male",
        "medium_low",
        "strong_documentary",
        "Bill",
    ),
    VoiceEntry(
        "onwK4e9ZLuTAKqWW03F9", "elevenlabs", "male", "medium", "deep_news", "Daniel"
    ),
    VoiceEntry(
        "29vD33N1CtxCmqQRPOHJ",
        "elevenlabs",
        "male",
        "medium",
        "well_rounded_news",
        "Drew",
    ),
    VoiceEntry(
        "5Q0t7uMcjvnagumLfvZi",
        "elevenlabs",
        "male",
        "medium_high",
        "ground_reporter",
        "Paul",
    ),
    VoiceEntry(
        "bVMeCyTHy58xNoL34h3p",
        "elevenlabs",
        "male",
        "medium_high",
        "excited_young",
        "Jeremy",
    ),
    VoiceEntry(
        "N2lVS1w4EtoT3dr4eOWO", "elevenlabs", "male", "low", "calm_deep", "Callum"
    ),
    VoiceEntry(
        "TX3LPaxmHKxFdv7VOQHJ",
        "elevenlabs",
        "male",
        "medium",
        "warm_storyteller",
        "Liam",
    ),
]

# OpenAI TTS voices — all 13 base voices
OPENAI_VOICES: list[VoiceEntry] = [
    VoiceEntry("alloy", "openai", "female", "medium", "neutral_balanced", "Alloy"),
    VoiceEntry("ash", "openai", "male", "medium_low", "warm_conversational", "Ash"),
    VoiceEntry("ballad", "openai", "male", "medium", "smooth_calm", "Ballad"),
    VoiceEntry("coral", "openai", "female", "medium_high", "warm_friendly", "Coral"),
    VoiceEntry("echo", "openai", "male", "low", "deep_resonant", "Echo"),
    VoiceEntry(
        "fable", "openai", "male", "medium_high", "expressive_storyteller", "Fable"
    ),
    VoiceEntry("nova", "openai", "female", "medium_high", "bright_energetic", "Nova"),
    VoiceEntry("onyx", "openai", "male", "low", "deep_authoritative", "Onyx"),
    VoiceEntry("sage", "openai", "female", "medium", "calm_measured", "Sage"),
    VoiceEntry("shimmer", "openai", "female", "high", "light_cheerful", "Shimmer"),
    VoiceEntry("verse", "openai", "male", "medium", "versatile_neutral", "Verse"),
    VoiceEntry("juniper", "openai", "female", "medium", "warm_narration", "Juniper"),
    VoiceEntry(
        "asteria", "openai", "female", "medium_high", "expressive_dynamic", "Asteria"
    ),
]

# Cartesia Sonic preset voices — 25 selected for diversity
CARTESIA_VOICES: list[VoiceEntry] = [
    # --- Female voices ---
    VoiceEntry(
        "a0e99841-438c-4a64-b679-ae501e7d6091",
        "cartesia",
        "female",
        "medium",
        "confident_narrator",
        "Sarah",
    ),
    VoiceEntry(
        "156fb8d2-335b-4950-9cb3-a2d33f91c6bb",
        "cartesia",
        "female",
        "medium_high",
        "cheerful_energetic",
        "Hannah",
    ),
    VoiceEntry(
        "c45bc5ec-dc68-4feb-8829-6e6b2748095d",
        "cartesia",
        "female",
        "medium_low",
        "calm_professional",
        "Molly",
    ),
    VoiceEntry(
        "2ee87190-8f84-4925-97da-e52547f9462c",
        "cartesia",
        "female",
        "medium",
        "warm_conversational",
        "Claire",
    ),
    VoiceEntry(
        "e3827ec5-697a-4b7c-9571-1b0f4f263a6d",
        "cartesia",
        "female",
        "high",
        "bright_youthful",
        "Sophie",
    ),
    VoiceEntry(
        "248be419-c632-4f23-adf1-5324ed7dbf1d",
        "cartesia",
        "female",
        "medium_high",
        "expressive_narrator",
        "Valentina",
    ),
    VoiceEntry(
        "bf991597-6c13-47e4-8411-91ec2de5c466",
        "cartesia",
        "female",
        "medium",
        "newscast_professional",
        "Nora",
    ),
    VoiceEntry(
        "b7d50908-b68c-4d39-b70a-ca7efa1894e4",
        "cartesia",
        "female",
        "medium_low",
        "deep_warm",
        "Maya",
    ),
    VoiceEntry(
        "71a7ad14-091c-4e8e-a314-022ece01c121",
        "cartesia",
        "female",
        "medium",
        "authoritative_strong",
        "Ava",
    ),
    VoiceEntry(
        "f9836c6e-a0bd-460e-9d3c-f7299fa60f94",
        "cartesia",
        "female",
        "medium_high",
        "friendly_casual",
        "Emma",
    ),
    # --- Male voices ---
    VoiceEntry(
        "a167e0f3-df7e-4d52-a9c3-f949145f52bd",
        "cartesia",
        "male",
        "medium",
        "confident_narrator",
        "James",
    ),
    VoiceEntry(
        "87748186-691b-4767-9883-07952b29c9df",
        "cartesia",
        "male",
        "low",
        "deep_authoritative",
        "Marcus",
    ),
    VoiceEntry(
        "565510e8-6b45-45de-8758-13588fbaec73",
        "cartesia",
        "male",
        "medium_high",
        "energetic_young",
        "Tyler",
    ),
    VoiceEntry(
        "41534e16-2966-4c6b-9670-111411def906",
        "cartesia",
        "male",
        "medium_low",
        "calm_storyteller",
        "Nathan",
    ),
    VoiceEntry(
        "69267136-1bdc-412f-ad78-0caad210fb40",
        "cartesia",
        "male",
        "medium",
        "warm_conversational",
        "Ethan",
    ),
    VoiceEntry(
        "a3520a8f-226a-428d-9fcd-b0a4711a6829",
        "cartesia",
        "male",
        "low",
        "deep_resonant",
        "Oscar",
    ),
    VoiceEntry(
        "ee7ea9f8-c0c1-498c-9f62-dc2da491f3c5",
        "cartesia",
        "male",
        "medium_high",
        "newscast_reporter",
        "Ryan",
    ),
    VoiceEntry(
        "638efaaa-4d0c-442e-b701-3fae16aad012",
        "cartesia",
        "male",
        "medium",
        "shouty_energetic",
        "Leo",
    ),
    VoiceEntry(
        "726d5ae5-055f-4c3d-8355-d9677b23e8e8",
        "cartesia",
        "male",
        "medium_low",
        "documentary_strong",
        "Daniel",
    ),
    VoiceEntry(
        "f114a467-c40a-4db8-964d-aaba89cd08fa",
        "cartesia",
        "male",
        "medium",
        "well_rounded",
        "Alex",
    ),
    VoiceEntry(
        "c8605446-247c-4d39-acd4-8f4c28aa363c",
        "cartesia",
        "male",
        "medium_high",
        "casual_friendly",
        "Jake",
    ),
    VoiceEntry(
        "d46abd1d-2571-44a3-b8ed-82e4d3403823",
        "cartesia",
        "male",
        "low",
        "calm_deep",
        "William",
    ),
    VoiceEntry(
        "fb26447f-308b-471e-8b00-8f9e70b15f94",
        "cartesia",
        "male",
        "medium",
        "expressive_dynamic",
        "Adrian",
    ),
    VoiceEntry(
        "00a77add-48d5-4ef6-8157-71e5b4a532e4",
        "cartesia",
        "male",
        "medium_low",
        "warm_mature",
        "Henry",
    ),
    VoiceEntry(
        "5c42302c-f55f-481c-b1dd-8b4cd3a0f2e0",
        "cartesia",
        "male",
        "medium_high",
        "excited_commentator",
        "Max",
    ),
]


VOICE_CATALOGS: dict[str, list[VoiceEntry]] = {
    "elevenlabs": ELEVENLABS_VOICES,
    "openai": OPENAI_VOICES,
    "cartesia": CARTESIA_VOICES,
}

# Pitch category → approximate F0 range center (Hz) for scoring
PITCH_CENTERS: dict[str, float] = {
    "low": 100,
    "medium_low": 130,
    "medium": 160,
    "medium_high": 190,
    "high": 230,
}


# ---------------------------------------------------------------------------
# Voice matcher
# ---------------------------------------------------------------------------


class VoiceMatcher:
    """Assigns and locks voices from a catalog based on speaker characteristics."""

    def __init__(self, provider: str):
        self._provider = provider
        self._catalog = list(VOICE_CATALOGS.get(provider, []))
        if not self._catalog:
            raise ValueError(f"No voice catalog for provider: {provider}")
        self._used_voice_ids: set[str] = set()
        self._locked: dict[int, VoiceEntry] = {}  # speaker_id -> locked entry

    def match_voice(
        self,
        gender: str,
        avg_pitch: float = 150.0,
        energy: float = 0.5,
    ) -> VoiceEntry:
        """Find the best matching voice from the catalog.

        Scoring:
          1. Filter by gender (with fallback to all voices)
          2. Score by pitch proximity
          3. Bonus for energy/style match
          4. Prefer unused voices
        """
        # Resolve "unknown" gender by leaning on pitch. The ambiguous band in
        # gender_from_pitch (160-180Hz) overlaps the male ceiling and female
        # floor; ~165Hz is a cleaner crossover. Without this, an unknown-gender
        # candidate falls back to all voices and pitch proximity alone can
        # pick a male voice for a female speaker (e.g. 174Hz → Drew at 160Hz).
        effective_gender = gender
        if effective_gender not in ("male", "female"):
            effective_gender = "female" if avg_pitch >= 165 else "male"

        # Filter by gender, prefer unused
        candidates = [
            v
            for v in self._catalog
            if v.gender == effective_gender and v.voice_id not in self._used_voice_ids
        ]
        if not candidates:
            # All voices of this gender are used — allow reuse
            candidates = [v for v in self._catalog if v.gender == effective_gender]
        if not candidates:
            # No voices of this gender — fall back to all unused
            candidates = [
                v for v in self._catalog if v.voice_id not in self._used_voice_ids
            ]
        if not candidates:
            candidates = list(self._catalog)

        best: Optional[VoiceEntry] = None
        best_score = -1.0

        for voice in candidates:
            score = 0.0

            # Pitch proximity: closer = higher score (max 5 points)
            voice_center = PITCH_CENTERS.get(voice.pitch_category, 160)
            pitch_dist = abs(avg_pitch - voice_center)
            score += max(0, 5.0 - pitch_dist / 20.0)

            # Energy/style match (max 3 points)
            energetic_styles = {
                "energetic",
                "energetic_young",
                "shouty_energetic",
                "excited_young",
                "excited_commentator",
                "bright_energetic",
                "expressive_dynamic",
                "bright_cheerful",
                "bright_youthful",
                "cheerful_energetic",
                "ground_reporter",
            }
            calm_styles = {
                "warm_calm",
                "deep_calm",
                "calm_deep",
                "calm_measured",
                "calm_professional",
                "calm_storyteller",
                "smooth_calm",
            }
            authoritative_styles = {
                "strong_confident",
                "deep_authoritative",
                "authoritative",
                "authoritative_strong",
                "crisp_strong",
                "strong_documentary",
                "documentary_strong",
                "newscast_professional",
                "newscast_reporter",
                "deep_news",
                "well_rounded_news",
            }

            if energy > 0.65 and voice.style in energetic_styles:
                score += 3.0
            elif energy < 0.35 and voice.style in calm_styles:
                score += 3.0
            elif 0.35 <= energy <= 0.65 and voice.style in authoritative_styles:
                score += 2.0
            elif 0.35 <= energy <= 0.65:
                score += 1.0  # neutral match for neutral energy

            # Small bonus for unused voices (prefer diversity)
            if voice.voice_id not in self._used_voice_ids:
                score += 0.5

            if score > best_score:
                best_score = score
                best = voice

        if best is None:
            best = candidates[0]

        return best

    def lock_voice(self, speaker_id: int, entry: VoiceEntry) -> None:
        """Permanently assign a voice to a speaker. Cannot be changed after."""
        self._locked[speaker_id] = entry
        self._used_voice_ids.add(entry.voice_id)
        logger.info(
            "Speaker %d: voice locked -> %s (%s, %s, %s)",
            speaker_id,
            entry.display_name,
            entry.gender,
            entry.pitch_category,
            entry.style,
        )

    def get_locked_voice(self, speaker_id: int) -> Optional[VoiceEntry]:
        """Return the locked voice for a speaker, or None if not locked."""
        return self._locked.get(speaker_id)

    def is_locked(self, speaker_id: int) -> bool:
        return speaker_id in self._locked

    def reset(self) -> None:
        """Reset all assignments (for cleanup)."""
        self._locked.clear()
        self._used_voice_ids.clear()
