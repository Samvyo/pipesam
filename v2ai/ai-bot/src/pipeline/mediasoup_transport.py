import asyncio
from loguru import logger

# from pipecat.frames.frames import AudioRawFrame, EndFrame
# from pipecat.processors.frame_processor import FrameProcessor
# from pipecat.transports.base_transport import BaseTransport

from .audio_utils import AudioFrame
from .rtp_receiver import RTPReceiver
from .rtp_sender import RTPSender
from .signalling import BotSignalling
from .config import Config
# from .video_rtp_receiver import VideoRTPReceiver


class MediasoupInputTransport:
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
                frame = AudioFrame(
                    audio=pcm,
                    sample_rate=16000,
                    num_channels=1
                )

                # make frame available to consumers
                await self.audio_queue.put(frame)
                
                # await self.push_frame(frame)
            except asyncio.CancelledError:
                logger.info("MediasoupInputTransport: receive loop cancelled")
                break
            except Exception as e:
                logger.error(f"MediasoupInputTransport error: {e}")

    # async def process_frame(self, frame, direction):
    #     # Input processor: just pass frames through unchanged
    #     await self.push_frame(frame, direction)


class MediasoupOutputTransport:
    """Receives AudioRawFrames from pipeline and sends via RTP."""

    def __init__(self, sender: RTPSender):
        super().__init__()
        self._sender = sender

    async def process_frame(self, frame, direction):
        if isinstance(frame, AudioFrame):
            # The frame declares its own rate — the sender resamples to the
            # 48kHz stereo the Opus encoder and mediasoup expect.
            self._sender.send_audio(
                frame.audio,
                sample_rate=frame.sample_rate,
                num_channels=frame.num_channels,
            )
            # Pass non-audio frames (e.g. EndFrame) downstream
            # await self.push_frame(frame, direction)


class MediasoupTransport:

    def __init__(self,vision=None):
        super().__init__()
        self._vision = vision
        self._receiver: RTPReceiver | None = None
        self._sender: RTPSender | None = None
        self._signalling: BotSignalling | None = None
        self._input_processor: MediasoupInputTransport | None = None
        self._output_processor: MediasoupOutputTransport | None = None
    #     self._video_receiver: VideoRTPReceiver | None = None

    # async def _video_debug_loop(self):
    #     while True:
    #         try:
    #             packet = await self._video_receiver.read_packet()

    #             logger.info(
    #                 f"🖥 VIDEO RTP PACKET size={len(packet)}"
    #             )

    #         except Exception as e:
    #             logger.error(
    #                 f"Video RTP error: {e}"
    #             )

    def input(self):
        return self._input_processor

    def output(self):
        return self._output_processor

    async def start(self):
        # Step 1 — bind RTP receiver
        self._receiver = RTPReceiver(host="127.0.0.1", port=0, vision=self._vision)
        actual_port = self._receiver.start()
        logger.info(f"🎧 RTP receiver bound on port {actual_port}")

        # Step 2 — connect signalling
        self._signalling = BotSignalling(
            server_url=Config.SIGNALLING_URL,
            token=Config.BOT_TOKEN,
            rtp_port=actual_port,
        )

        self._signalling._vision = self._vision

        self._receiver._signalling = self._signalling 
        
        await self._signalling.connect()

        # Step 3 — start listen() FIRST so _wait_for futures work
        asyncio.create_task(self._signalling.listen())

        # Step 4 — setup receive path (join room, create transport)
        await self._signalling.setup(room_id=Config.BOT_ROOM_ID)

        # Step 5 — setup send path (bot → browser)
        await self._signalling.setup_send_path()
        self._sender = self._signalling.sender
        logger.info("✅ Send path ready")

        # Step 6 — create frame processors
        self._input_processor = MediasoupInputTransport(self._receiver)
        self._output_processor = MediasoupOutputTransport(self._sender)

        # Step 7 — start RTP read loop
        await self._input_processor.start()

        logger.info("✅ MediasoupTransport fully started")
        # No ready.wait() — consumers created dynamically as producers arrive

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