import asyncio
import websockets
import json
import ssl
from loguru import logger

# Handles WebSocket signalling between the Python bot and MediaSoup server.
class BotSignalling:
    def __init__(self, server_url: str, token: str, rtp_port: int):
        self.server_url = server_url
        self.token      = token
        self.rtp_port   = rtp_port
        # self.video_rtp_port = video_rtp_port
        
        self.ws         = None
        self.transport_id  = None
        self.consumer_id   = None
        self.sender        = None

        self.video_ai_consent = {}
        self.latest_video_producer = {}
        self.active_video_consumers = set()

        self.ssrc_to_peer = {}
        self.current_speaker = "unknown"
        self.mute_states = {}

        self.room_id = None

        # bot.py waits on this before reading RTP packets
        self.ready = asyncio.Event()

        self._pending      = {}

        self.consumer_lock = asyncio.Lock()

    # Establish a secure WebSocket connection to the signalling server.
    async def connect(self):
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode    = ssl.CERT_NONE

        url = f"{self.server_url}?token={self.token}"
        self.ws = await websockets.connect(url, ssl=ssl_ctx)
        logger.info("✅ Bot connected to signalling server")

    # Configure MediaSoup consumer transport and start receiving browser audio via RTP.
    async def setup(self, room_id: str):

        self.room_id = room_id

        await self._send({'type': 'join-room'})

        # RPC 1: Join the room so the server can register the bot as a room participant
        await self._send({'type': 'join-room'})
        logger.info(f"📥 Bot joined room: {room_id}")

        # RPC 2: Create a PlainTransport that MediaSoup will use to send RTP audio to the bot.
        await self._send({'type': 'create-bot-transport'})
        response = await self._wait_for('bot-transport-created')
        self.transport_id = response['id']
        logger.info(f"🔌 Consumer transport created: {self.transport_id} server at {response['ip']}:{response['port']}")

        # Connect the MediaSoup transport to the bot's RTP receiver UDP port.
        await self._send({
            'type':        'connect-bot-transport',
            'transportId': self.transport_id,
            'ip':          '127.0.0.1',
            'port':        self.rtp_port,
        })
        await self._wait_for('bot-transport-connected')
        logger.info(f"✅ Consumer transport connected → port {self.rtp_port}")


        # # RPC 3: Create a consumer for the browser's audio producer on the bot transport.
        # await self._send({
        #     'type':        'create-bot-consumer',
        #     'transportId': self.transport_id,
        # })
        # response = await self._wait_for('bot-consumer-created')

        # logger.info(
        #     f"FULL BOT-CONSUMER RESPONSE: {response}"
        # )

        # ssrc = response["rtpParameters"]["encodings"][0]["ssrc"]

        # peer_id = response.get(
        #     "peerId",
        #     "unknown"
        # )

        # self.ssrc_to_peer[ssrc] = peer_id

        # # TEMPORARY: single-user testing
        # self.current_speaker = peer_id

        # logger.info(
        #     f"🗣 SSRC MAP: "
        #     f"{ssrc} -> {peer_id}"
        # )
        # self.consumer_id = response['consumerId']
        # logger.info(
        #     f"🎧 Consumer created: {self.consumer_id} "
        #     f"kind={response['kind']}"
        # )

        # # RPC 4: Resume the consumer so RTP packets begin flowing from MediaSoup to the bot.
        # await self._send({
        #     'type':        'resume-bot-consumer',
        #     'transportId': self.transport_id,
        # })
        # await self._wait_for('bot-consumer-resumed')
        # logger.info("▶️  RTP flowing — browser audio arriving at port 55000")

        # # Signal that RTP is ready and the bot can begin reading audio packets.
        # self.ready.set()

    # Configure MediaSoup producer transport and start sending bot audio via RTP.
    async def setup_send_path(self):
        from .rtp_sender import RTPSender, make_rtp_parameters

        # RPC 5: Create a PlainTransport that receives RTP audio from the bot.
        await self._send({
            'type': 'create-bot-producer-transport'
        })
        msg = await self._wait_for('bot-producer-transport-created')

        transport_id = msg['id']
        ip           = msg['ip']
        port         = msg['port']
        logger.info(f"🔌 Producer transport created: {ip}:{port}")

        # Create RTP sender using the transport IP and port provided by MediaSoup
        self.sender = RTPSender(host=ip, port=port)
        self.sender.start()
        logger.info("📡 Warming up comedia — sending 5 packets...")

        # Send initial RTP packets so MediaSoup can learn the bot's UDP source address.
        for _ in range(5):
            self.sender.send_tone_frame(freq=440.0)
            await asyncio.sleep(0.02)

        # RPC 6: Create a MediaSoup producer for the bot's RTP audio stream.
        await self._send({
            'type':          'create-bot-producer',
            'transportId':   transport_id,
            'rtpParameters': make_rtp_parameters(
                ssrc=self.sender.ssrc,
                payload_type=120
            ),
        })
        msg = await self._wait_for('bot-producer-created')
        logger.info(f"🎵 Producer created: {msg['producerId']}")

        # Start continuous RTP audio transmission in a background task.
        # asyncio.create_task(
        #     self.sender.stream_tone(freq=440.0)
        # )

    async def create_consumer(
        self,
        producer_id
    ):
        async with self.consumer_lock:
            await self._send({
                'type': 'create-bot-consumer',
                'transportId': self.transport_id,
                'producerId': producer_id,
            })

            response = await self._wait_for(
                'bot-consumer-created'
            )

            ssrc = response["rtpParameters"]["encodings"][0]["ssrc"]

            peer_id = response.get(
                "peerId",
                "unknown"
            )

            self.ssrc_to_peer[ssrc] = peer_id

            # self.current_speaker = peer_id

            logger.info(
                f"🗣 SSRC MAP: {ssrc} -> {peer_id}"
            )

            await self._send({
                'type': 'resume-bot-consumer',
                'transportId': self.transport_id,
            })
            await self._wait_for(
                'bot-consumer-resumed'
            )

            logger.info(
                f"🎧 Consumer created for {peer_id}"
            )

            self.ready.set()

    async def create_video_consumer(
        self,
        producer_id
    ):
        if producer_id in self.active_video_consumers:
            logger.info(
                f"Video consumer already exists for {producer_id}"
            )
            return
        
        async with self.consumer_lock:

            await self._send({
                'type': 'create-bot-consumer',
                'transportId': self.transport_id,
                'producerId': producer_id,
            })

            response = await self._wait_for(
                'bot-consumer-created'
            )

            logger.info(
                f"🖥 VIDEO CONSUMER CREATED: "
                f"{response.get('kind')}"
            )

            logger.info(
                f"🖥 VIDEO RTP PARAMS: "
                f"{response.get('rtpParameters')}"
            )

            await self._send({
                'type': 'resume-bot-consumer',
                'transportId': self.transport_id,
            })

            await self._wait_for(
                'bot-consumer-resumed'
            )

            logger.info(
                "🖥 Video consumer resumed"
            )
            self.active_video_consumers.add(producer_id)
            # Request keyframe — bot joined after stream started
            await asyncio.sleep(0.3)
            await self.request_keyframe()

    # Continuously listen for signalling messages from the server.
    # async def listen(self):
    #     try:
    #         async for raw in self.ws:
    #             msg = json.loads(raw)
    #             logger.debug(f"[signalling] ← {msg['type']}")
    #             # logger.info(
    #             #     f"[signalling] ← {msg}"
    #             # )

    #             if msg["type"] == "new-audio-producer":

    #                 logger.info(
    #                     f"🎤 New producer detected: "
    #                     f"{msg['peerId']}"
    #                 )

    #                 await self.create_consumer(
    #                     msg["producerId"]
    #                 )

    #     except Exception as e:
    #         logger.warning(f"[signalling] connection closed: {e}")

    async def request_keyframe(self):
        """Send PLI to browser — forces it to send a VP8 keyframe immediately."""
        await self._send({'type': 'request-keyframe'})
        logger.info("📡 PLI requested — browser will send keyframe")

    async def listen(self):
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                logger.info(f"[signalling] ← {msg}") 

                msg_type = msg['type']

                # deliver to any _wait_for caller first
                if msg_type in self._pending:
                    fut = self._pending.pop(msg_type)
                    if not fut.done():
                        fut.set_result(msg)
                    continue

                if msg_type == 'bot-error':
                    logger.error(f"❌ Server error: {msg.get('message')}")
                    for fut in self._pending.values():
                        if not fut.done():
                            fut.set_exception(Exception(msg.get('message')))
                    self._pending.clear()
                    continue

                if msg_type == 'new-audio-producer':
                    logger.info(f"🎤 New producer detected: {msg['peerId']}")
                    asyncio.create_task(
                        self.create_consumer(msg['producerId'])
                    )
                elif msg_type == "new-video-producer":
                    logger.info(
                        f"🖥 Screen share detected from {msg['peerId']}"
                    )

                    if hasattr(self, "_vision") and self._vision:
                        self._vision.screen_share_active = True
                        self._vision.current_screen_sharer = msg["peerId"]
                    
                    self.latest_video_producer[msg["peerId"]] = msg["producerId"]

                    if self.video_ai_consent.get(msg["peerId"], False):
                        logger.info(
                            f"✅ AI consent enabled for {msg['peerId']} - creating video consumer"
                        )

                        asyncio.create_task(
                            self.create_video_consumer(
                                msg["producerId"]
                            )
                        )

                    else:
                        logger.info(
                            f"⛔ AI consent not enabled for {msg['peerId']} - skipping video consumer"
                        )

                elif msg_type == "video-ai-consent":

                    peer_id = msg["peerId"]
                    consent = msg["consent"]

                    self.video_ai_consent[peer_id] = consent

                    logger.info(
                        f"🤖 AI Consent: {peer_id} -> {consent}"
                    )

                    if consent:

                        producer_id = self.latest_video_producer.get(peer_id)

                        if producer_id:

                            logger.info(
                                f"Creating video consumer after consent for {peer_id}"
                            )

                            asyncio.create_task(
                                self.create_video_consumer(
                                    producer_id
                                )
                            )

                    else:

                        logger.info(
                            f"AI consent disabled for {peer_id}"
                        )

                        self.latest_video_producer.pop(peer_id, None)

                elif msg_type == "mute-status":
                    peer_id = msg.get("from")
                    muted   = msg.get("muted", False)
                    self.mute_states[peer_id] = muted
                    logger.info(f"🔇 Mute state: {peer_id} → {'muted' if muted else 'unmuted'}")

                
                elif msg_type == "screen-share-stop":

                    logger.info("🛑 Screen share stopped")

                    peer_id = msg.get("from")

                    producer_id = None

                    if peer_id:
                        producer_id = self.latest_video_producer.pop(peer_id, None)

                    if producer_id:
                        self.active_video_consumers.discard(producer_id)

                    if hasattr(self, "_vision") and self._vision:
                        self._vision.screen_share_active = False
                        self._vision.current_screen_sharer = None
                
        except Exception as e:
            logger.warning(f"[signalling] connection closed: {e}")

    # Send a JSON signalling message to the server over WebSocket. 
    async def _send(self, msg: dict):
        """Send one JSON message to server."""
        await self.ws.send(json.dumps(msg))
        logger.debug(f"[signalling] → {msg['type']}")

    # Wait for a specific server response while ignoring unrelated messages.
    # async def _wait_for(self, msg_type: str) -> dict:
    #     while True:
    #         raw = await self.ws.recv()
    #         msg = json.loads(raw)
    #         logger.info(f"[signalling] ← {msg}")

    #         if msg['type'] == msg_type:
    #             return msg

    #         if msg['type'] == 'bot-error':
    #             logger.error(
    #                 f"❌ Server error: {msg.get('message')}"
    #             )
    #             raise Exception(
    #                 f"Server error: {msg.get('message')}"
    #             )

    async def _wait_for(self, msg_type: str) -> dict:
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        self._pending[msg_type] = fut
        return await fut
    
    async def send_transcript(
        self,
        speaker,
        text,
        confidence,
        ts
    ):
        await self._send({
            "type": "transcript",
            "speaker": speaker,
            "text": text,
            "confidence": confidence,
            "ts": ts
        })
    async def send_action_items(self, items):
        await self._send({
            "type": "action-items",
            "items": items
        })
    async def send_slide_summary(self, summary):
        await self._send({
            "type": "slide-summary",
            "summary": summary,
        })
    
    # Close RTP sender and WebSocket connection during shutdown.  
    async def close(self):
        if self.sender:
            self.sender.close()
        if self.ws:
            await self.ws.close()
            logger.info("🔌 Signalling connection closed")