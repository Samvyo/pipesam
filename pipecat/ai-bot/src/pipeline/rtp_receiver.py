import socket
import opuslib
import asyncio
from loguru import logger

# RTP header is always 12 bytes
RTP_HEADER_SIZE = 12

# Must match mediasoup Opus settings
OPUS_SAMPLE_RATE = 48000   # mediasoup sends Opus at 48khz
OPUS_CHANNELS = 2          # mediasoup sends stereo
OUTPUT_SAMPLE_RATE = 16000 # Deepgram wants 16khz
OUTPUT_CHANNELS = 1        # Deepgram wants mono

# 20ms frame size at 48khz = 48000 × 0.02 (20 ms) = 960 samples per channel
OPUS_FRAME_SIZE = 960

class RTPReceiver:
    def __init__(self, host='127.0.0.1', port=0):
        # port=0 means OS picks a free port automatically
        self.host = host
        self.port = port
        self.sock = None
        self.decoder = None
        self._pcm_buffer = bytearray()

    def start(self):
        # Create UDP socket
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        
        # Bind to the port
        # port=0 → OS assigns free port, we read it back
        self.sock.bind((self.host, self.port))
        
        # Read back the actual port OS assigned
        self.port = self.sock.getsockname()[1]
        
        # Non-blocking so we can use with asyncio
        self.sock.setblocking(False)
        
        # Create Opus decoder
        # mediasoup sends 48khz stereo Opus
        self.decoder = opuslib.Decoder(
            OPUS_SAMPLE_RATE,
            OPUS_CHANNELS
        )
        
        logger.info(f"🎧 RTP UDP socket bound on port {self.port}")
        return self.port  # caller needs this port number

    # Parses RTP header fields (version, payload type, sequence, timestamp, SSRC, etc.) for debugging and stream validation.
    def parse_rtp_header(self, packet: bytes) -> dict:
        import struct
        if len(packet) < 12:
            return {}

        byte0 = packet[0]
        version = (byte0 >> 6) & 0x03
        padding = (byte0 >> 5) & 0x01
        extension = (byte0 >> 4) & 0x01
        cc = (byte0 >> 0) & 0x0F

        byte1 = packet[1]
        marker = (byte1 >> 7) & 0x01
        payload_type = (byte1 >> 0) & 0x7F

        seq = struct.unpack_from('!H', packet, 2)[0] 
        timestamp = struct.unpack_from('!I', packet, 4)[0]
        ssrc = struct.unpack_from('!I', packet, 8)[0]

        return {
            'version': version,
            'padding': padding,
            'extension': extension,
            'cc': cc,
            'marker': marker,
            'payload_type': payload_type,
            'sequence': seq,
            'timestamp': timestamp,
            'ssrc': ssrc,
        }

    # Calculates actual RTP header size and removes it, returning only the Opus audio payload.
    def _strip_rtp_header(self, packet: bytes) -> bytes:
        if len(packet) <= RTP_HEADER_SIZE:
            return b''

        # check for header extension (X bit in byte 0)
        has_extension = (packet[0] >> 4) & 0x01

        # CC = CSRC count, bottom 4 bits of byte 0
        cc = packet[0] & 0x0F
        header_size = 12 + (cc * 4)

        if has_extension and len(packet) > header_size + 4:
            # extension header:
            ext_length = (packet[header_size + 2] << 8) | packet[header_size + 3]
            # extension total size = 4 bytes header + length * 4 bytes
            header_size += 4 + (ext_length * 4)

        if len(packet) <= header_size:
            return b''

        return packet[header_size:]

    # Decode compressed Opus payload into raw 48kHz stereo PCM audio.
    def _decode_opus_to_pcm(self, opus_bytes: bytes) -> bytes:
        try:
            # decode() returns raw PCM as bytes
            # OPUS_FRAME_SIZE = samples per channel per frame
            pcm = self.decoder.decode(
                opus_bytes,
                OPUS_FRAME_SIZE
            )
            return pcm
        except Exception as e:
            logger.warning(f"Opus decode error: {e}")
            return b''

    # Convert 48kHz stereo PCM into 16kHz mono PCM required by Deepgram. 
    def _stereo_48k_to_mono_16k(self, pcm_48k_stereo: bytes) -> bytes:
        import struct
        
        # Stereo = 2 samples per frame = 4 bytes per frame
        samples = struct.unpack(
            f'<{len(pcm_48k_stereo)//2}h',
            pcm_48k_stereo
        )
        
        # Step 1: stereo to mono
        # samples = [L, R, L, R, L, R, ...]
        # mono = average of L and R
        mono = []
        for i in range(0, len(samples), 2):
            left = samples[i]
            right = samples[i + 1] if i + 1 < len(samples) else left
            avg = (left + right) // 2
            mono.append(avg)
        
        # Step 2: downsample 48khz → 16khz
        # Keep every 3rd sample (48000 / 3 = 16000)
        downsampled = mono[::3]
        
        # Pack back to bytes
        return struct.pack(f'<{len(downsampled)}h', *downsampled)

    # Receive RTP packets, extract Opus audio, decode to PCM, and return Deepgram-ready audio chunks.
    async def read_pcm_chunk(self) -> bytes:
        loop = asyncio.get_event_loop()
        
        while True:
            try:
                packet = await loop.run_in_executor(
                    None,
                    lambda: self.sock.recv(4096)
                )
                if not hasattr(self, '_header_logged'):
                    self._header_logged = True
                    h = self.parse_rtp_header(packet)
                    logger.info(
                        f"🔬 RTP Header decoded:\n"
                        f"   version={h['version']} (always 2 for RTP)\n"
                        f"   payload_type={h['payload_type']} (Opus codec)\n"
                        f"   sequence={h['sequence']} (packet counter)\n"
                        f"   timestamp={h['timestamp']} (increases by 960 per packet)\n"
                        f"   ssrc={h['ssrc']} (unique stream ID)\n"
                        f"   marker={h['marker']} (1=first packet after silence)"
                    )
                # Step 1: remove 12-byte RTP header
                opus_bytes = self._strip_rtp_header(packet)
                if not opus_bytes:
                    continue
                
                # Step 2: decode Opus → PCM 48khz stereo
                pcm_48k = self._decode_opus_to_pcm(opus_bytes)
                if not pcm_48k:
                    continue
                
                # Step 3: convert to 16khz mono for Deepgram
                pcm_16k = self._stereo_48k_to_mono_16k(pcm_48k)
                
                return pcm_16k
                
            except BlockingIOError:
                # No packet available yet, wait a little
                await asyncio.sleep(0.005)
                continue

    # Return the UDP port currently used by the RTP receiver.
    def get_port(self) -> int:
        return self.port

    # Close the RTP receiver socket and stop receiving audio packets.
    def close(self):
        if self.sock:
            self.sock.close()
            logger.info("🔌 RTP socket closed")