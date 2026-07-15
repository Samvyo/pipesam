import asyncio
from loguru import logger
from deepgram import (
    DeepgramClient,
    LiveOptions,
    LiveTranscriptionEvents,
)
from .config import Config

CHUNK = 1024
RATE  = 16000  # microphone input sample rate (Hz)


class DeepgramSTT:
    """
    Deepgram live speech-to-text client.

    Streams 32ms PCM chunks to Deepgram over a WebSocket and fires
    the on_transcript callback whenever a final transcript arrives.
    Automatically reconnects if the connection drops.
    """

    def __init__(self):
        self._client           = DeepgramClient(Config.DEEPGRAM_API_KEY)
        self._connection       = self._client.listen.asynclive.v("1")
        self._on_transcript_cb = None
        self._on_recovery_cb = None
        self._running          = False
        self._recovery_notified = False
        logger.info("✅ DeepgramSTT initialized")

    def on_transcript(self, callback):
        self._on_transcript_cb = callback

    def on_recovery(self, callback):
        self._on_recovery_cb = callback

     # ── Event handlers ───────────────────────────────────────────────────────
    async def _on_transcript_handler(self, self_inner, result, **kwargs):
        if not result.is_final:
            return
        alt        = result.channel.alternatives[0]
        text       = alt.transcript.strip()
        confidence = alt.confidence
        if not text:
            return
        if self._on_transcript_cb:
            try:
                await self._on_transcript_cb(text, confidence)
            except Exception as e:
                logger.error(f"Transcript callback failed: {e}")

    async def _on_error_handler(self, error, **kwargs):
        logger.error(f"Deepgram error: {error}")
    
    async def _on_close_handler(self, close, **kwargs):
        logger.warning("⚠️ Deepgram connection closed")
        await self._notify_failure()

    # ── Failure notification (single source of truth) ──────────────────────
    async def _notify_failure(self):
        if self._running and not self._recovery_notified:
            self._recovery_notified = True
            if self._on_recovery_cb:
                await self._on_recovery_cb()


    async def start(self):
        self._connection.on(LiveTranscriptionEvents.Transcript, self._on_transcript_handler)
        self._connection.on(LiveTranscriptionEvents.Error,      self._on_error_handler)
        self._connection.on(LiveTranscriptionEvents.Close,      self._on_close_handler)

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
        self._running = True
        self._recovery_notified = False
        asyncio.create_task(self._keep_alive())


    async def send(self, pcm_chunk: bytes):
        try:
            await self._connection.send(pcm_chunk)
        except Exception as e:
            logger.error(f"Deepgram send error: {e}")
            await self._notify_failure()
 
    async def finalize(self, speech_buffer: bytes = None):
        try:
            await self._connection.finalize()
        except Exception as e:
            logger.error(f"Deepgram finalize error: {e}")
            await self._notify_failure()



    async def stop(self):
        self._running = False
        try:
            await self._connection.finish()
        except Exception:
            pass

   
    #         await asyncio.sleep(3)
    async def _keep_alive(self):
        while self._running:
            try:
                if self._connection:
                    await self._connection.keep_alive()
            except Exception as e:
                logger.error(f"keep_alive failed: {e}")
                await self._notify_failure()
                break   # <-- Stop the keep_alive loop
 
            await asyncio.sleep(3)