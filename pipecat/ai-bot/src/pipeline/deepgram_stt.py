import asyncio
from loguru import logger
from deepgram import (
    DeepgramClient,
    LiveOptions,
    LiveTranscriptionEvents,
)
from .config import Config

CHUNK = 1024
RATE  = 16000


class DeepgramSTT:

    def __init__(self):
        self._client          = DeepgramClient(Config.DEEPGRAM_API_KEY)
        self._connection      = self._client.listen.asynclive.v("1")
        self._on_transcript_cb = None
        logger.info("✅ DeepgramSTT initialized")

    def on_transcript(self, callback):
        self._on_transcript_cb = callback

    async def start(self):

        async def _on_transcript(self_inner, result, **kwargs):
            if not result.is_final:
                return
            alt        = result.channel.alternatives[0]
            text       = alt.transcript.strip()
            confidence = alt.confidence
            logger.info(
                f"🔍 Deepgram Result | "
                f"is_final={result.is_final} | "
                f"text='{text}' | "
                f"confidence={confidence:.2f}"
            )
            if not text:
                return
            if self._on_transcript_cb:
                await self._on_transcript_cb(text, confidence)

        async def _on_error(self_inner, error, **kwargs):
            logger.error(f"Deepgram error: {error}")

        self._connection.on(
            LiveTranscriptionEvents.Transcript, _on_transcript
        )
        self._connection.on(
            LiveTranscriptionEvents.Error, _on_error
        )

        options = LiveOptions(
            model=Config.STT_MODEL,
            language=Config.STT_LANGUAGE,
            smart_format=True,
            interim_results=True,
            encoding="linear16",
            channels=1,
            sample_rate=RATE,
            endpointing=1000,
        )

        success = await self._connection.start(options)
        if not success:
            raise RuntimeError("Deepgram websocket failed to start")

        logger.info("✅ Deepgram connection started")
        asyncio.create_task(self._keep_alive())

    async def send(self, pcm_chunk: bytes):
        # streams each 32ms chunk to Deepgram live
        try:
            await self._connection.send(pcm_chunk)
        except Exception as e:
            logger.error(f"Deepgram send error: {e}")

    async def finalize(self, speech_buffer: bytes = None):
        # speech_buffer not used by Deepgram
        # Deepgram already received all chunks via send()
        try:
            await self._connection.finalize()
            logger.info("✅ Deepgram finalize sent")
        except Exception as e:
            logger.error(f"Deepgram finalize error: {e}")

    async def stop(self):
        try:
            await self._connection.finish()
        except Exception as e:
            logger.error(f"Deepgram stop error: {e}")

    async def _keep_alive(self):
        # sends silence every 3s so Deepgram doesn't timeout
        silence = b'\x00' * CHUNK * 2
        while True:
            try:
                await self._connection.send(silence)
            except Exception:
                break
            await asyncio.sleep(3)