import socket
import struct
import time
import math
import asyncio
import numpy as np
import opuslib
import soxr
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

        # Streaming resampler. It carries filter state between calls, so
        # consecutive chunks join seamlessly instead of clicking at every seam.
        self._resampler     = None
        self._resample_rate = None   # input rate the resampler was built for
    
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

    def _to_48k_stereo(self, pcm_mono: bytes, sample_rate: int) -> bytes:
        # The Opus encoder was created for 48kHz stereo, so whatever the TTS
        # provider gave us has to land there. TTS rates vary (Deepgram/Cartesia
        # follow TTS_SAMPLE_RATE, Kokoro is natively 24kHz), so the input rate
        # is whatever the caller declares — never assumed.
        mono = np.frombuffer(pcm_mono, dtype=np.int16)

        if sample_rate != SAMPLE_RATE:
            if sample_rate != self._resample_rate:
                # first chunk, or the rate changed — start a fresh resampler
                self._resample_rate = sample_rate
                self._resampler = soxr.ResampleStream(
                    sample_rate,      # from
                    SAMPLE_RATE,      # to: 48kHz
                    1,                # mono
                    dtype="int16",
                    quality="HQ",
                )

            mono = self._resampler.resample_chunk(mono)

        # mono → stereo: same sample on both channels, interleaved L,R,L,R...
        return np.repeat(mono, 2).tobytes()


    def send_audio(self, pcm_mono: bytes, sample_rate: int, num_channels: int = 1):
        if not pcm_mono:
            return

        # Step 1: fold to mono if the caller handed us stereo
        if num_channels == 2:
            stereo = np.frombuffer(pcm_mono, dtype=np.int16).reshape(-1, 2)
            pcm_mono = stereo.mean(axis=1).astype(np.int16).tobytes()

        # Step 2: resample to 48kHz stereo to match the encoder and what we
        # told mediasoup in rtpParameters
        pcm_48k = self._to_48k_stereo(pcm_mono, sample_rate)

        # Step 3: buffer incoming audio

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