"""
Speaker embedding + online clustering for the streaming pipeline.

Uses SpeechBrain's ECAPA-TDNN (spkrec-ecapa-voxceleb) to compute 192-dim
speaker embeddings per utterance, then clusters them online. The result
is a cluster_id that overrides Deepgram's speaker_id — fixing cases
where Deepgram collapses multiple speakers into one label, or swaps IDs
mid-conversation.

Design:
- Model is loaded once, shared across sessions (thread-safe lazy init).
- Each Session owns its own SpeakerEmbedder with independent clusters.
- Online clustering: compute cosine sim against existing centroids;
  merge if >= SIMILARITY_THRESHOLD, else create new cluster.
- Centroid is updated as a running unit-normalized average.
- Short utterances (< MIN_AUDIO_SEC) are not embedded — too noisy.
- MAX_CLUSTERS cap prevents runaway cluster creation on bad audio.

Environment:
- ENABLE_SPEAKER_CLUSTERING=1 (default) to enable; =0 to disable.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# Minimum audio length (seconds) for a reliable embedding.
# Anything shorter gives noisy embeddings that pollute clusters.
MIN_AUDIO_SEC = 0.8

# Cosine similarity threshold for merging an utterance into an existing
# cluster. Tuned conservatively — err on the side of creating a new
# cluster (false split) vs collapsing two speakers (false merge).
# ECAPA cosine sim typically: same speaker ≥ 0.75, different ≤ 0.45.
SIMILARITY_THRESHOLD = 0.65

# Safety cap on distinct clusters. Real sports talk shows rarely
# exceed 4-5 speakers. More likely suggests bad audio creating spurious clusters.
MAX_CLUSTERS = 8


@dataclass
class SpeakerCluster:
    cluster_id: int
    centroid: np.ndarray  # 192-dim, unit-normalized
    count: int  # number of utterances merged so far


class SpeakerEmbedder:
    """Per-session online speaker embedding + clustering.

    One instance per Session. The underlying ECAPA model is shared
    across all instances via a class-level singleton.
    """

    _shared_model = None
    _model_lock = threading.Lock()
    _model_unavailable = False  # set True after first load failure; stops retries

    def __init__(self):
        self._clusters: list[SpeakerCluster] = []
        self._next_id = 0

    # ------------------------------------------------------------------
    # Model (shared across sessions)
    # ------------------------------------------------------------------

    @classmethod
    def _get_model(cls):
        """Lazy-load ECAPA-TDNN. First call takes ~1-2s; subsequent are free."""
        if cls._shared_model is not None:
            return cls._shared_model
        with cls._model_lock:
            if cls._shared_model is not None:
                return cls._shared_model
            from speechbrain.inference.classifiers import EncoderClassifier

            cls._shared_model = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                savedir="pretrained_models/spkrec-ecapa-voxceleb",
                run_opts={"device": "cpu"},
            )
            logger.info("ECAPA-TDNN loaded (spkrec-ecapa-voxceleb)")
        return cls._shared_model

    @classmethod
    def warmup(cls) -> bool:
        """Force-load the model. Call during server startup / user's buffer
        phase so the first real utterance doesn't pay the load cost."""
        if cls._model_unavailable:
            return False
        try:
            cls._get_model()
            return True
        except Exception as e:
            cls._model_unavailable = True
            logger.warning("ECAPA warmup failed: %s — clustering disabled", e)
            return False

    # ------------------------------------------------------------------
    # Embedding
    # ------------------------------------------------------------------

    def embed(
        self, pcm16_bytes: bytes, sample_rate: int = 16000
    ) -> Optional[np.ndarray]:
        """Compute a 192-dim unit-normalized embedding. None if audio too short."""
        if not pcm16_bytes or self._model_unavailable:
            return None
        pcm = np.frombuffer(pcm16_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        if len(pcm) < int(sample_rate * MIN_AUDIO_SEC):
            return None
        try:
            import torch

            model = self._get_model()
            wav = torch.from_numpy(pcm).unsqueeze(0)  # [1, samples]
            with torch.no_grad():
                emb = model.encode_batch(wav).squeeze().cpu().numpy()
            norm = float(np.linalg.norm(emb))
            if norm < 1e-8:
                return None
            return (emb / norm).astype(np.float32)
        except Exception as e:
            type(self)._model_unavailable = True
            logger.warning("Embedding failed: %s — clustering disabled", e)
            return None

    # ------------------------------------------------------------------
    # Online clustering
    # ------------------------------------------------------------------

    def assign_cluster(self, embedding: np.ndarray) -> int:
        """Find best-matching cluster or create a new one. Returns cluster_id."""
        if embedding is None:
            return 0

        best_idx = -1
        best_sim = -1.0
        for idx, c in enumerate(self._clusters):
            sim = float(np.dot(embedding, c.centroid))
            if sim > best_sim:
                best_sim = sim
                best_idx = idx

        if best_idx >= 0 and best_sim >= SIMILARITY_THRESHOLD:
            c = self._clusters[best_idx]
            # Running unit-normalized average
            c.count += 1
            new_centroid = (c.centroid * (c.count - 1) + embedding) / c.count
            norm = float(np.linalg.norm(new_centroid))
            c.centroid = (
                (new_centroid / norm).astype(np.float32) if norm > 1e-8 else c.centroid
            )
            logger.debug(
                "Cluster %d: merged utterance (sim=%.2f, count=%d)",
                c.cluster_id,
                best_sim,
                c.count,
            )
            return c.cluster_id

        # Create new cluster
        if len(self._clusters) >= MAX_CLUSTERS:
            # At cap — merge into closest anyway to avoid unbounded growth
            if best_idx >= 0:
                c = self._clusters[best_idx]
                c.count += 1
                logger.info(
                    "Cluster cap reached — merging utterance into cluster %d (sim=%.2f)",
                    c.cluster_id,
                    best_sim,
                )
                return c.cluster_id
            return 0

        new_id = self._next_id
        self._next_id += 1
        self._clusters.append(
            SpeakerCluster(cluster_id=new_id, centroid=embedding.copy(), count=1)
        )
        logger.info(
            "New speaker cluster: id=%d (total=%d, best_sim_to_existing=%.2f)",
            new_id,
            len(self._clusters),
            best_sim,
        )
        return new_id

    def embed_and_assign(
        self, pcm16_bytes: bytes, sample_rate: int = 16000
    ) -> Optional[int]:
        """Convenience: embed + cluster in one call. None if not embedded."""
        emb = self.embed(pcm16_bytes, sample_rate)
        if emb is None:
            return None
        return self.assign_cluster(emb)

    # ------------------------------------------------------------------
    # Introspection (for logging / tests)
    # ------------------------------------------------------------------

    @property
    def num_clusters(self) -> int:
        return len(self._clusters)
