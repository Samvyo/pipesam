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
        self._send_buffer = bytearray()
    
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

    # Encode raw PCM audio into a compressed Opus frame.
    def _encode_opus(self, pcm_bytes: bytes) -> bytes:
        return self.encoder.encode(pcm_bytes, FRAME_SIZE)

    # ADD these two methods to RTPSender class
    def _mono_16k_to_stereo_48k(self, pcm_16k_mono: bytes) -> bytes:
        # Why this method exists:
        # Deepgram TTS outputs 16kHz mono PCM
        # But Opus encoder was initialized with SAMPLE_RATE=48000, CHANNELS=2
        # So we must upsample before encoding
        # 16000 × 3 = 48000 (repeat each sample 3 times)
        # mono → stereo (duplicate sample for left and right)
        samples = struct.unpack(
            f'<{len(pcm_16k_mono) // 2}h',
            pcm_16k_mono
        )
        upsampled = []
        for s in samples:
            for _ in range(3):       # upsample 16k → 48k
                upsampled.append(s)  # left channel
                upsampled.append(s)  # right channel (mono → stereo)
        return struct.pack(f'<{len(upsampled)}h', *upsampled)


    def send_audio(self, pcm_16k_mono: bytes):
    
        # Step 1: upsample 16kHz mono → 48kHz stereo
        # Why: Opus encoder needs 48kHz stereo to match what we told MediaSoup
        pcm_48k = self._mono_16k_to_stereo_48k(pcm_16k_mono)

        # Step 2: buffer incoming audio
        
        self._send_buffer.extend(pcm_48k)

        bytes_per_frame = FRAME_SIZE * CHANNELS * 2  # 960 * 2 * 2 = 3840

        # Step 3: drain buffer in exact 3840-byte chunks
        while len(self._send_buffer) >= bytes_per_frame:
            chunk = bytes(self._send_buffer[:bytes_per_frame])
            del self._send_buffer[:bytes_per_frame]

            # → encode Opus
            opus_bytes = self._encode_opus(chunk)

            # → RTP header
            header = self._make_rtp_header()

            # → UDP send to MediaSoup → browser
            packet = header + opus_bytes
            self.sock.sendto(packet, (self.host, self.port))

            # advance RTP counters for next packet
            self.seq       = (self.seq + 1)        & 0xFFFF
            self.timestamp = (self.timestamp + FRAME_SIZE) & 0xFFFFFFFF 

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