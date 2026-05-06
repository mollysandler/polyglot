"""
Tests for the ECAPA-TDNN speaker embedding + online clustering (BUG-027).

These tests exercise the clustering logic only. The actual embedding model
(SpeechBrain ECAPA) is a real neural net — too heavy to run in unit tests —
so we inject synthetic embeddings directly via assign_cluster() and
mock-embed for a few integration-style tests.
"""

from __future__ import annotations

import os

import numpy as np

os.environ.setdefault("DEEPGRAM_API_KEY", "test-key")


def unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / (np.linalg.norm(v) + 1e-8)


# ===========================================================================
# Clustering logic (no model needed)
# ===========================================================================


class TestClustering:
    def test_first_utterance_creates_cluster_0(self):
        from speaker_embedder import SpeakerEmbedder

        e = SpeakerEmbedder()
        emb = unit([1.0, 0.0, 0.0])
        assert e.assign_cluster(emb) == 0
        assert e.num_clusters == 1

    def test_similar_embedding_merges_into_existing_cluster(self):
        from speaker_embedder import SpeakerEmbedder

        e = SpeakerEmbedder()
        e.assign_cluster(unit([1.0, 0.0, 0.0]))
        # Tiny perturbation — cosine ~ 0.99
        cid = e.assign_cluster(unit([0.99, 0.14, 0.0]))
        assert cid == 0
        assert e.num_clusters == 1

    def test_dissimilar_embedding_creates_new_cluster(self):
        from speaker_embedder import SpeakerEmbedder

        e = SpeakerEmbedder()
        e.assign_cluster(unit([1.0, 0.0, 0.0]))  # cluster 0
        # Orthogonal — cosine 0, well below 0.65 threshold
        cid = e.assign_cluster(unit([0.0, 1.0, 0.0]))
        assert cid == 1
        assert e.num_clusters == 2

    def test_two_speakers_alternate_assignment(self):
        """Simulates a man/woman conversation — two distinct embedding types."""
        from speaker_embedder import SpeakerEmbedder

        e = SpeakerEmbedder()
        voice_A = unit([1.0, 0.2, 0.1])
        voice_B = unit([0.1, 0.2, 1.0])

        # Alternating utterances with slight jitter
        rng = np.random.default_rng(42)
        ids = []
        for i in range(8):
            base = voice_A if i % 2 == 0 else voice_B
            noise = rng.normal(0, 0.05, size=base.shape).astype(np.float32)
            ids.append(e.assign_cluster(unit(base + noise)))

        # Should converge on exactly 2 clusters
        assert e.num_clusters == 2
        # And assignment alternates
        even_ids = {ids[i] for i in range(0, 8, 2)}
        odd_ids = {ids[i] for i in range(1, 8, 2)}
        assert len(even_ids) == 1
        assert len(odd_ids) == 1
        assert even_ids != odd_ids

    def test_centroid_updates_as_running_average(self):
        from speaker_embedder import SpeakerEmbedder

        e = SpeakerEmbedder()
        e.assign_cluster(unit([1.0, 0.0, 0.0]))  # centroid = [1,0,0]
        e.assign_cluster(unit([0.99, 0.14, 0.0]))  # merges, centroid moves slightly
        # Centroid should still be mostly aligned with [1,0,0]
        centroid = e._clusters[0].centroid
        assert centroid[0] > 0.99 or (centroid @ unit([1.0, 0.0, 0.0])) > 0.995
        assert e._clusters[0].count == 2

    def test_none_embedding_returns_cluster_0(self):
        """Short/unembeddable audio falls through to cluster 0 safely."""
        from speaker_embedder import SpeakerEmbedder

        e = SpeakerEmbedder()
        assert e.assign_cluster(None) == 0
        assert e.num_clusters == 0  # no cluster created

    def test_max_clusters_cap_forces_merge(self):
        from speaker_embedder import MAX_CLUSTERS, SpeakerEmbedder

        e = SpeakerEmbedder()
        # Fill to cap with orthogonal-ish embeddings
        for i in range(MAX_CLUSTERS):
            v = np.zeros(8, dtype=np.float32)
            v[i] = 1.0
            e.assign_cluster(unit(v))
        assert e.num_clusters == MAX_CLUSTERS

        # Another truly novel embedding: should merge into nearest, not grow
        novel = np.ones(8, dtype=np.float32)
        cid = e.assign_cluster(unit(novel))
        assert e.num_clusters == MAX_CLUSTERS
        assert 0 <= cid < MAX_CLUSTERS


# ===========================================================================
# embed(): audio-length gating
# ===========================================================================


class TestEmbed:
    def test_empty_audio_returns_none(self):
        from speaker_embedder import SpeakerEmbedder

        e = SpeakerEmbedder()
        assert e.embed(b"") is None

    def test_audio_below_min_length_returns_none(self):
        """Anything under MIN_AUDIO_SEC should skip embedding (noisy)."""
        from speaker_embedder import MIN_AUDIO_SEC, SpeakerEmbedder

        e = SpeakerEmbedder()
        # A hair under the threshold at 16kHz PCM16
        too_short_samples = int(16000 * MIN_AUDIO_SEC) - 100
        pcm = (np.zeros(too_short_samples, dtype=np.int16)).tobytes()
        assert e.embed(pcm) is None


# ===========================================================================
# embed_and_assign(): end-to-end with mocked embed()
# ===========================================================================


class TestEmbedAndAssign:
    def test_short_audio_returns_none_cluster(self, monkeypatch):
        from speaker_embedder import SpeakerEmbedder

        e = SpeakerEmbedder()
        monkeypatch.setattr(e, "embed", lambda *_args, **_kw: None)
        # Short audio: embed returns None → embed_and_assign returns None
        # so the caller keeps Deepgram's ID unchanged
        assert e.embed_and_assign(b"\x00\x00" * 100) is None

    def test_long_audio_goes_through_clustering(self, monkeypatch):
        from speaker_embedder import SpeakerEmbedder

        e = SpeakerEmbedder()
        # Fake two distinct speakers' embeddings
        seq = iter([unit([1.0, 0.0, 0.0]), unit([0.0, 1.0, 0.0])])
        monkeypatch.setattr(e, "embed", lambda *_args, **_kw: next(seq))

        id_1 = e.embed_and_assign(b"\x00\x00" * 16000)
        id_2 = e.embed_and_assign(b"\x00\x00" * 16000)
        assert id_1 != id_2
        assert e.num_clusters == 2


# ===========================================================================
# Regression: session.py wiring toggle
# ===========================================================================


class TestSessionToggle:
    def test_default_is_on(self, monkeypatch):
        """Clustering is on by default (no env set)."""
        monkeypatch.delenv("ENABLE_SPEAKER_CLUSTERING", raising=False)
        assert os.environ.get("ENABLE_SPEAKER_CLUSTERING", "1") == "1"

    def test_session_wires_embedder_when_on(self, monkeypatch):
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        import session as session_mod

        monkeypatch.setattr(session_mod, "_CLUSTERING_ENABLED", True)
        s = session_mod.Session("es", "en", send_text=None, send_bytes=None)
        assert s._embedder is not None

    def test_session_skips_embedder_when_off(self, monkeypatch):
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        import session as session_mod

        monkeypatch.setattr(session_mod, "_CLUSTERING_ENABLED", False)
        s = session_mod.Session("es", "en", send_text=None, send_bytes=None)
        assert s._embedder is None
