"""
Modal deployment for the streaming translation pipeline.

Two service classes:
  1. StreamingService (CPU-only) — WebSocket streaming for live translation
  2. BatchService (GPU A10G) — existing batch translation

The streaming service uses Deepgram + Google Translate + ElevenLabs APIs,
so no GPU is needed.
"""

import modal
import os

app = modal.App("sports-translation-v2")

# Secrets
secrets = [modal.Secret.from_name("sports-secrets")]

# Feedback volume (shared with batch)
FEEDBACK_VOLUME = modal.Volume.from_name("sports-feedback", create_if_missing=True)

# ---------------------------------------------------------------------------
# Streaming service (CPU-only, lightweight)
# ---------------------------------------------------------------------------

streaming_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "fastapi>=0.115",
        "uvicorn",
        "websockets>=12.0",
        "deepgram-sdk>=6.0",
        "elevenlabs>=2.32",
        "deep-translator",
        "httpx",
        "numpy",
        "openai>=1.0",  # OpenAI TTS provider (optional)
        "cartesia",  # Cartesia TTS provider (optional)
    )
    .add_local_file("protocol.py", remote_path="/root/protocol.py", copy=True)
    .add_local_file(
        "deepgram_client.py", remote_path="/root/deepgram_client.py", copy=True
    )
    .add_local_file("tts_provider.py", remote_path="/root/tts_provider.py", copy=True)
    .add_local_file("voice_catalog.py", remote_path="/root/voice_catalog.py", copy=True)
    .add_local_file("tts_client.py", remote_path="/root/tts_client.py", copy=True)
    .add_local_file(
        "speaker_manager.py", remote_path="/root/speaker_manager.py", copy=True
    )
    .add_local_file("translator.py", remote_path="/root/translator.py", copy=True)
    .add_local_file("session.py", remote_path="/root/session.py", copy=True)
    .add_local_file(
        "streaming_server.py", remote_path="/root/streaming_server.py", copy=True
    )
    .add_local_file("utils.py", remote_path="/root/utils.py", copy=True)
)


@app.cls(
    image=streaming_image,
    cpu=2,
    memory=2048,
    timeout=60 * 60,
    secrets=secrets,
    min_containers=1,
    max_containers=4,
)
@modal.concurrent(max_inputs=10)
class StreamingService:
    """CPU-only streaming translation via WebSocket."""

    @modal.asgi_app()
    def web(self):
        import logging

        logging.basicConfig(level=logging.INFO)

        from streaming_server import app as streaming_app

        # Add CORS middleware
        from starlette.middleware.cors import CORSMiddleware

        streaming_app.add_middleware(
            CORSMiddleware,
            allow_origins=[
                "chrome-extension://*",
                "http://localhost:5173",
                "https://sport-translations.vercel.app",
            ],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

        return streaming_app


# ---------------------------------------------------------------------------
# Batch service (GPU, existing pipeline)
# ---------------------------------------------------------------------------

HF_CACHE = modal.Volume.from_name("sports-hf-cache", create_if_missing=True)
TORCH_CACHE = modal.Volume.from_name("sports-torch-cache", create_if_missing=True)

batch_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("ffmpeg", "sox", "libsndfile1")
    .env(
        {
            "HF_HOME": "/cache/hf",
            "TRANSFORMERS_CACHE": "/cache/hf",
            "TORCH_HOME": "/cache/torch",
            "TRANSLATION_BACKEND": os.getenv("TRANSLATION_BACKEND", "local"),
            "COQUI_TOS_AGREED": "1",
            "HF_HUB_DISABLE_XET": "1",
            "USE_VOICE_CLONING": "0",
        }
    )
    .pip_install_from_requirements("requirements.txt")
    .pip_install_from_requirements("requirements_gpu.txt")
    .add_local_dir(".", remote_path="/root", copy=True)
)


@app.cls(
    image=batch_image,
    gpu="A10G",
    cpu=4,
    memory=16384,
    timeout=60 * 60,
    secrets=secrets,
    max_containers=1,
    volumes={
        "/cache/hf": HF_CACHE,
        "/cache/torch": TORCH_CACHE,
        "/feedback": FEEDBACK_VOLUME,
    },
    enable_memory_snapshot=True,
)
class BatchService:
    """GPU batch translation (existing pipeline)."""

    @modal.enter()
    def load_models(self):
        import torch
        from utils import TTSConfig, SpeakerMergeConfig

        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True

        self._translator_cache = {}
        self._sessions: dict = {}
        self._tts_config = TTSConfig(
            qwen_enable=True, qwen_device="cuda", xtts_enable=True, xtts_device="cuda"
        )
        self._speaker_merge = SpeakerMergeConfig()

    def _get_translator(self, source_lang: str, target_lang: str):
        from main import DynamicSpeakerTranslator

        key = (source_lang, target_lang)
        if key not in self._translator_cache:
            self._translator_cache[key] = DynamicSpeakerTranslator(
                source_lang=source_lang,
                target_lang=target_lang,
                use_voice_cloning=False,
                max_workers=3,
                tts_config=self._tts_config,
                speaker_merge=self._speaker_merge,
            )
        return self._translator_cache[key]

    @modal.asgi_app()
    def fastapi_app(self):
        from api_server import make_app

        return make_app(self)
