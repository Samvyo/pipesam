import asyncio
import time
import numpy as np
from loguru import logger
from faster_whisper import WhisperModel
from .config import Config

RATE = 16000


class WhisperSTT:

    def __init__(self):
        model_size = Config.WHISPER_MODEL
        logger.info(f"⏳ Loading Whisper model: {model_size}")
        self._model = WhisperModel(
            model_size,
            device="cpu",
            compute_type="int8"
        )
        self._on_transcript_cb = None
        logger.info("✅ WhisperSTT initialized")

    def on_transcript(self, callback):
        self._on_transcript_cb = callback

    async def start(self):
        # nothing to connect — Whisper is local
        logger.info("✅ Whisper ready (local)")

    async def send(self, pcm_chunk: bytes):
        # Whisper does not stream — chunks are buffered by bot.py
        pass

    async def finalize(self, speech_buffer: bytes):
        # called by bot.py when VAD detects end of utterance
        text = await self._transcribe(speech_buffer)
        if text and self._on_transcript_cb:
            await self._on_transcript_cb(text, confidence=1.0)

    async def stop(self):
        pass

    async def _transcribe(self, pcm_bytes: bytes) -> str:
        if not pcm_bytes:
            return ""

        loop = asyncio.get_running_loop()

        def _run():
            samples = np.frombuffer(
                pcm_bytes, dtype=np.int16
            ).astype(np.float32) / 32768.0

            start = time.time()
            segments, _ = self._model.transcribe(
                samples,
                beam_size=1,
                language="en",
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=500)
            )
            text    = " ".join(s.text for s in segments).strip()
            elapsed = time.time() - start
            logger.info(f"⏱️ Whisper latency: {elapsed:.2f}s")
            return text

        return await loop.run_in_executor(None, _run)