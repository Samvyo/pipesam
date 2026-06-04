import asyncio
from loguru import logger

from pipecat.frames.frames import AudioRawFrame, EndFrame
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.transports.base_transport import BaseTransport

from .rtp_receiver import RTPReceiver
from .rtp_sender import RTPSender
from .signalling import BotSignalling
from .config import Config


class MediasoupInputTransport(FrameProcessor):
    """Reads RTP audio and pushes AudioRawFrames downstream."""

    def __init__(self, receiver: RTPReceiver):
        super().__init__()
        self._receiver = receiver
        self._task: asyncio.Task | None = None

        # queue for bot/VAD consumers
        self.audio_queue = asyncio.Queue()

    async def start(self):
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()

    async def _run(self):
        while True:
            try:
                pcm: bytes = await self._receiver.read_pcm_chunk()
                frame = AudioRawFrame(
                    audio=pcm,
                    sample_rate=16000,
                    num_channels=1
                )

                # make frame available to consumers
                await self.audio_queue.put(frame)
                
                await self.push_frame(frame)
            except asyncio.CancelledError:
                logger.info("MediasoupInputTransport: receive loop cancelled")
                break
            except Exception as e:
                logger.error(f"MediasoupInputTransport error: {e}")

    async def process_frame(self, frame, direction):
        # Input processor: just pass frames through unchanged
        await self.push_frame(frame, direction)


class MediasoupOutputTransport(FrameProcessor):
    """Receives AudioRawFrames from pipeline and sends via RTP."""

    def __init__(self, sender: RTPSender):
        super().__init__()
        self._sender = sender

    async def process_frame(self, frame, direction):
        if isinstance(frame, AudioRawFrame):
            self._sender.send_audio(frame.audio)
        else:
            # Pass non-audio frames (e.g. EndFrame) downstream
            await self.push_frame(frame, direction)


class MediasoupTransport(BaseTransport):

    def __init__(self):
        super().__init__()
        self._receiver: RTPReceiver | None = None
        self._sender: RTPSender | None = None
        self._signalling: BotSignalling | None = None
        self._input_processor: MediasoupInputTransport | None = None
        self._output_processor: MediasoupOutputTransport | None = None
    def input(self) -> FrameProcessor:
        return self._input_processor

    def output(self) -> FrameProcessor:
        return self._output_processor

    async def start(self):
        # Create and bind RTP receiver
        self._receiver = RTPReceiver(host="127.0.0.1", port=55000)
        actual_port = self._receiver.start()
        logger.info(f"🎧 RTP receiver bound on port {actual_port}")

        # Connect signalling
        self._signalling = BotSignalling(
            server_url=Config.SIGNALLING_URL,
            token=Config.BOT_TOKEN,
            rtp_port=actual_port
        )
        await self._signalling.connect()

        # Receive path: browser → bot
        await self._signalling.setup(
            room_id=Config.BOT_ROOM_ID,
            producer_id=Config.BOT_PRODUCER_ID
        )
        await self._signalling.ready.wait()
        logger.info("✅ Receive path ready — browser audio flowing into bot")

        # Send path: bot → browser
        await self._signalling.setup_send_path()
        self._sender = self._signalling.sender
        logger.info("✅ Send path ready — bot audio will flow to browser")

        # Create FrameProcessors now that receiver/sender exist
        self._input_processor = MediasoupInputTransport(self._receiver)
        self._output_processor = MediasoupOutputTransport(self._sender)

        # Start the RTP receive loop
        await self._input_processor.start()

        logger.info("✅ MediasoupTransport fully started")

    async def stop(self):
        if self._input_processor:
            await self._input_processor.stop()
        if self._receiver:
            self._receiver.close()
        if self._sender:
            self._sender.close()
        if self._signalling:
            await self._signalling.close()
        logger.info("✅ MediasoupTransport stopped")