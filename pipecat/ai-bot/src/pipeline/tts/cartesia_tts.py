"""
Cartesia TTS provider — primary voice engine.

Owns the fallback chain: Cartesia → Deepgram → Kokoro.
Callers just call stream(text) and never need to know a fallback happened.
Uses a persistent WebSocket connection to keep latency under 400ms.
Mid-stream failures are not retried — partial audio already played.
"""


from loguru import logger
from cartesia import AsyncCartesia

from ..config import Config
from .deepgram_tts import DeepgramTTS
from .kokoro_tts import KokoroTTS
import time


class CartesiaTTS:
    def __init__(self):
        self.client = AsyncCartesia(api_key=Config.CARTESIA_API_KEY)
        self._ws = None

    async def connect(self):
        """Call at startup to pre-warm the WebSocket."""
        if self._ws is None:
            self._ws = await self.client.tts.websocket()
            logger.info("✅ Cartesia WebSocket pre-warmed")

    async def close(self):
        """Call at shutdown to close the WebSocket cleanly."""
        if self._ws:
            await self._ws.close()
            self._ws = None
            logger.info("✅ Cartesia WebSocket closed")

    async def stream(self, text: str):
        logger.info("🟢 USING CARTESIA")
        # 1. Try Cartesia
        sent_any = False
        try:
            async for chunk in self._stream_cartesia(text):
                sent_any = True
                yield chunk
            return
        except Exception as e:
            if sent_any:
                logger.error(f"❌ Cartesia TTS failed mid-stream ({e}) — not retrying, audio already partially played")
                return
            logger.warning(f"⚠️ Cartesia TTS failed before producing audio ({e}) — falling back to Deepgram")

        # 2. Fall back to Deepgram
        sent_any = False
        try:
            dg = DeepgramTTS()
            async for chunk in dg.stream(text):
                sent_any = True
                yield chunk
            return
        except Exception as e:
            if sent_any:
                logger.error(f"❌ Deepgram fallback failed mid-stream ({e}) — not retrying")
                return
            logger.warning(f"⚠️ Deepgram fallback failed before producing audio ({e}) — falling back to Kokoro")

        # 3. Fall back to Kokoro (local, no network — last resort)
        try:
            kk = KokoroTTS()
            async for chunk in kk.stream(text):
                yield chunk
        except Exception as e:
            logger.error(f"❌ Kokoro fallback also failed ({e}) — no audio produced for this sentence")

    async def _stream_cartesia(self, text: str):
        if self._ws is None:
            await self.connect()

        model_id = getattr(Config, "CARTESIA_MODEL", "sonic-2")
        logger.info(f"🎤 Using Cartesia Voice ID: {Config.CARTESIA_VOICE_ID}")
        start = time.time()
        first_chunk = True

        response = await self._ws.send(
            model_id=model_id,
            transcript=text,
            voice={"id": Config.CARTESIA_VOICE_ID},
            language="en",
            output_format={
                "container": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": Config.TTS_SAMPLE_RATE,
            },
        )

        async for chunk in response:
            if first_chunk:
                # logger.info(f"🚀 First chunk in {(time.time() - start) * 1000:.0f}ms")
                first_chunk = False
            if chunk.audio:
                yield chunk.audio