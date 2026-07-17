"""
Deepgram TTS provider — fallback #1 after Cartesia.
Calls Deepgram's REST speak endpoint, gets full audio in one shot,
and yields it as raw PCM s16le bytes at Config.TTS_SAMPLE_RATE.
"""

from loguru import logger
from deepgram import DeepgramClient

from ..config import Config


class DeepgramTTS:
    def __init__(self):
        # Deepgram renders at whatever rate we ask for, so config is the truth.
        self.sample_rate = Config.TTS_SAMPLE_RATE

        self.client = DeepgramClient(Config.DEEPGRAM_API_KEY)

    async def stream(self, text: str):
        logger.info("🟡 USING DEEPGRAM")
        response = await self.client.asyncspeak.v("1").stream(
            {"text": text},
            options={
                "model": Config.TTS_VOICE,
                "encoding": "linear16",
                "sample_rate": Config.TTS_SAMPLE_RATE,
            },
        )

        audio_data = response.stream.read()

        if not audio_data:
            logger.warning("⚠️ Deepgram TTS returned empty audio")
            return

        yield audio_data