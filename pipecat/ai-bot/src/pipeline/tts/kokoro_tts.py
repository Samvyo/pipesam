import asyncio

import numpy as np
from loguru import logger

from ..config import Config

KOKORO_SAMPLE_RATE = 24000  # native Kokoro output rate


class KokoroTTS:
    # Loading the model is slow (~seconds) and memory heavy, so it's
    # loaded once per process and shared across instances.
    _pipeline = None

    def __init__(self):
        logger.info(
            f"🎤 Kokoro voice configured: {Config.KOKORO_VOICE}"
        )
        if KokoroTTS._pipeline is None:
            from kokoro import KPipeline
            logger.info("🔧 Loading local Kokoro model (first use only)...")
            # lang_code 'a' = American English voices (af_*, am_*)
            KokoroTTS._pipeline = KPipeline(lang_code="a")
            logger.info("✅ Kokoro model loaded")
        self.pipeline = KokoroTTS._pipeline

    async def stream(self, text: str):
        logger.info("🔴 USING KOKORO")
        """
        Yield raw PCM16 audio bytes for `text`.
        Kokoro's pipeline() call is a blocking generator (CPU/GPU bound),
        so it's run in a thread executor to avoid blocking the event loop.
        """
        loop = asyncio.get_running_loop()
        voice = getattr(Config, "KOKORO_VOICE", "af_heart")

        segments = await loop.run_in_executor(
            None,
            lambda: list(self.pipeline(text, voice=voice)),
        )

        if not segments:
            logger.warning("⚠️ Kokoro TTS returned no audio segments")
            return

        for _graphemes, _phonemes, audio in segments:
            audio_np = audio.numpy() if hasattr(audio, "numpy") else np.asarray(audio)
            pcm16 = (np.clip(audio_np, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
            if pcm16:
                yield pcm16