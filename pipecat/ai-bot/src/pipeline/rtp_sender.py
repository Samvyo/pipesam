import socket
import struct
import time
import math
import asyncio
import opuslib
from loguru import logger

# Opus settings — must match what we tell mediasoup
SAMPLE_RATE   = 48000   # Hz
CHANNELS      = 2       # stereo
FRAME_SIZE    = 960     # samples per frame = 20ms at 48khz
PAYLOAD_TYPE  = 120     # dynamic PT, must match rtpParameters

class RTPSender:
    # Initialize RTP sender state, stream identifiers, and target MediaSoup transport details.
    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.sock = None
        self.encoder = None
        self.seq = 0          # sequence number, increases by 1
        self.timestamp = 0    # increases by FRAME_SIZE each packet
        self.ssrc = 12345678  # any fixed number, identifies our stream
    
    # Create UDP socket and initialize the Opus encoder for RTP audio transmission.
    def start(self):
        self.sock = socket.socket(
            socket.AF_INET,
            socket.SOCK_DGRAM
        )
        # Encoder: 48khz stereo
        self.encoder = opuslib.Encoder(
            SAMPLE_RATE,
            CHANNELS,
            opuslib.APPLICATION_VOIP
        )
        logger.info(
            f"📡 RTP sender ready → {self.host}:{self.port}"
        )

    # Construct a standard 12-byte RTP header containing version, payload type, sequence, timestamp, and SSRC.
    def _make_rtp_header(self) -> bytes:
        byte0 = 0x80          # V=2, P=0, X=0, CC=0
        byte1 = PAYLOAD_TYPE  # M=0, PT=120

        header = struct.pack(
            '!BBHII',    # big-endian: byte, byte, ushort, uint, uint
            byte0,
            byte1,
            self.seq      & 0xFFFF,
            self.timestamp & 0xFFFFFFFF,
            self.ssrc
        )
        return header

    # Generate a 20ms PCM sine-wave audio frame at the specified frequency.
    def _generate_sine_frame(self, freq: float = 440.0) -> bytes:
        samples = []
        for i in range(FRAME_SIZE):
            # sine wave formula: amplitude * sin(2π * freq * t)
            t = (self.timestamp + i) / SAMPLE_RATE
            val = int(32767 * 0.3 * math.sin(2 * math.pi * freq * t))
            val = max(-32768, min(32767, val))  # clamp to int16 range
            samples.append(val)  # left channel
            samples.append(val)  # right channel (same = mono tone)

        return struct.pack(f'<{len(samples)}h', *samples)

    # Encode raw PCM audio into a compressed Opus frame.
    def _encode_opus(self, pcm_bytes: bytes) -> bytes:
        return self.encoder.encode(pcm_bytes, FRAME_SIZE)


    # Create an RTP packet by generating PCM audio, encoding it to Opus, and sending it to MediaSoup over UDP.
    def send_tone_frame(self, freq: float = 440.0):
        # Step 1: generate raw PCM sine wave
        pcm = self._generate_sine_frame(freq)

        # Step 2: encode PCM → Opus
        opus_bytes = self._encode_opus(pcm)

        # Step 3: build RTP header
        header = self._make_rtp_header()

        # Step 4: combine header + Opus payload
        packet = header + opus_bytes

        # Step 5: send UDP packet to mediasoup
        self.sock.sendto(packet, (self.host, self.port))

        # Step 6: increment counters for next packet
        self.seq       = (self.seq + 1) & 0xFFFF
        self.timestamp = (self.timestamp + FRAME_SIZE) & 0xFFFFFFFF
    

    # Continuously stream RTP audio frames at 20ms intervals until stopped or duration expires.
    async def stream_tone(
        self,
        freq: float = 440.0,
        duration_seconds: float = None
    ):
        logger.info(
            f"🎵 Streaming {freq}Hz tone → "
            f"{self.host}:{self.port}"
        )
        start = time.time()
        try:
            while True:
                self.send_tone_frame(freq)
                # send one frame every 20ms
                await asyncio.sleep(0.02)

                if duration_seconds:
                    if time.time() - start >= duration_seconds:
                        break
        except asyncio.CancelledError:
            logger.info("🛑 Tone streaming stopped")

    # Close the RTP UDP socket and release network resources.
    def close(self):
        if self.sock:
            self.sock.close()
            logger.info("📡 RTP sender closed")


# Build MediaSoup RTP parameters describing the bot's Opus codec, payload type, and SSRC configuration.
def make_rtp_parameters(ssrc: int, payload_type: int) -> dict:
    return {
        'codecs': [{
            'mimeType':    'audio/opus',
            'payloadType': payload_type,
            'clockRate':   48000,
            'channels':    2,
            'parameters': {
                'minptime':     10,
                'useinbandfec': 1,
            }
        }],
        'encodings': [{
            'ssrc': ssrc
        }]
    }