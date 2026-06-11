import socket
import opuslib
import asyncio
import audioop
import struct
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

PCM_48K_SILENCE_BYTES = OPUS_FRAME_SIZE * OPUS_CHANNELS * 2

PCM_16K_SILENCE_BYTES = (OPUS_FRAME_SIZE // 3) * OUTPUT_CHANNELS * 2

class RTPReceiver:
    def __init__(self, host='127.0.0.1', port=0):
        # port=0 means OS picks a free port automatically
        self.host = host
        self.port = port
        self.sock = None
        self.decoders = {}
        self._skip_count = {}  # count of packets to skip after corruption detected
        self._header_logged = False  # log RTP header info only for the first packet
        self._signalling = None 

    def start(self):
        # Create UDP socket
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        
        # Bind to the port
        # port=0 → OS assigns free port, we read it back
        self.sock.bind((self.host, self.port))
        
        # Read back the actual port OS assigned
        self.port = self.sock.getsockname()[1]
        
        # Non-blocking so we can use with asyncio
        self.sock.setblocking(True)
        
        # Create Opus decoder
        # mediasoup sends 48khz stereo Opus
        # if ssrc in self.decoders:
        #     del self.decoders[ssrc]
        
        logger.info(f"🎧 RTP UDP socket bound on port {self.port}")
        return self.port  # caller needs this port number

    # Parses RTP header fields (version, payload type, sequence, timestamp, SSRC, etc.) for debugging and stream validation.
    def parse_rtp_header(self, packet: bytes) -> dict:
        if len(packet) < 12:
            return {}

        byte0 = packet[0]
        byte1 = packet[1]
       

        if byte1 in {200, 201, 202, 203, 204, 205, 206}:
            return {}
        payload_type = byte1 & 0x7F
        version = (byte0 >> 6) & 0x03
        padding = (byte0 >> 5) & 0x01
        extension = (byte0 >> 4) & 0x01
        cc = (byte0 >> 0) & 0x0F

        # byte1 = packet[1]
        marker = (byte1 >> 7) & 0x01
        # payload_type = (byte1 >> 0) & 0x7F

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
    
    def _get_audio_level(self, packet: bytes, header: dict) -> int:
        if not header.get('extension'):
            return -1

        cc = header['cc']
        ext_offset = 12 + (cc * 4)

        if len(packet) < ext_offset + 4:
            return -1

        # one-byte header extension profile = 0xBEDE
        profile = struct.unpack_from('!H', packet, ext_offset)[0]
        if profile != 0xBEDE:
            return -1

        ext_len = struct.unpack_from('!H', packet, ext_offset + 2)[0]
        pos = ext_offset + 4
        end = pos + (ext_len * 4)

        while pos < end and pos < len(packet):
            byte = packet[pos]
            if byte == 0:       # padding byte
                pos += 1
                continue
            ext_id = (byte >> 4) & 0x0F
            ext_size = (byte & 0x0F) + 1
            pos += 1
            if ext_id == 6 and pos < len(packet):   # id=6 is ssrc-audio-level
                level = packet[pos] & 0x7F           # mask off V bit
                return level                         # 0=loud, 127=silence
            pos += ext_size

        return -1
    
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
        
        # logger.info(
        #     f"📦 RTP packet={len(packet)} "
        #     f"header={header_size} "
        #     f"payload={len(packet[header_size:])}"
        # )

        return packet[header_size:]

    # Decode compressed Opus payload into raw 48kHz stereo PCM audio.
    def _decode_opus_to_pcm(self, ssrc: int, opus_bytes: bytes):
        try:

            if ssrc not in self.decoders:

                logger.info(
                    f"🎧 Creating decoder for SSRC {ssrc}"
                )

                self.decoders[ssrc] = opuslib.Decoder(
                    OPUS_SAMPLE_RATE,
                    OPUS_CHANNELS
                )

            # decode() returns raw PCM as bytes
            # OPUS_FRAME_SIZE = samples per channel per frame
            pcm = self.decoders[ssrc].decode(
                opus_bytes,
                OPUS_FRAME_SIZE
            )
            return pcm, False  # False = not silence
        except Exception as e:
            logger.warning(f"Opus decode error: {e}")
            # return b''
            # ✅ Reset decoder so next packet starts fresh
            self.decoders[ssrc] = opuslib.Decoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS)
            
            # ✅ Return silence instead of empty bytes
            # 960 samples × 2 channels × 2 bytes = 3840 bytes of silence
            return bytes(OPUS_FRAME_SIZE * OPUS_CHANNELS * 2), True  # True = silence

   
    def _stereo_48k_to_mono_16k(self, pcm_48k_stereo: bytes) -> bytes:
        mono_48k = audioop.tomono(pcm_48k_stereo, 2, 0.5, 0.5)
        mono_16k, _ = audioop.ratecv(mono_48k, 2, 1, 48000, 16000, None)
        return mono_16k

    # Receive RTP packets, extract Opus audio, decode to PCM, and return Deepgram-ready audio chunks.
    async def read_pcm_chunk(self) -> bytes:
        loop = asyncio.get_running_loop()
        
        while True:
            try:
                packet = await loop.run_in_executor(
                    None,
                    lambda: self.sock.recv(4096)
                )

                header = self.parse_rtp_header(packet)

                if not header:
                    continue

                ssrc = header["ssrc"]

                if self._signalling and ssrc in self._signalling.ssrc_to_peer:
                    self._signalling.current_speaker = self._signalling.ssrc_to_peer[ssrc]

                # Audio level 127 = fully muted. Threshold 40 filters out
                # anything that is not real speech before it reaches the decoder.
                audio_level = self._get_audio_level(packet, header)
                if audio_level != -1 and audio_level > 40:
                    continue
                
                if not self._header_logged:
                    self._header_logged = True
                    h = header
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
                pcm_48k, is_corrupt = self._decode_opus_to_pcm(ssrc, opus_bytes)

                if is_corrupt:
                    self._skip_count[ssrc] = 3 # skip next 3 packets after corruption
                    silence_16k = bytes(PCM_16K_SILENCE_BYTES)
                    return silence_16k
 
                if self._skip_count.get(ssrc, 0) > 0:
                    self._skip_count[ssrc] -= 1
                    return bytes(PCM_16K_SILENCE_BYTES)
 
                # Step 3 — downsample 48kHz stereo → 16kHz mono
                pcm_16k = self._stereo_48k_to_mono_16k(pcm_48k)
        
                return pcm_16k


            # except BlockingIOError:
            #         await asyncio.sleep(0.005)
            except asyncio.CancelledError:
                raise
                
            except Exception as e:
                    logger.error(f"RTP recv error: {e}")
                    await asyncio.sleep(0.005)

    # Return the UDP port currently used by the RTP receiver.
    def get_port(self) -> int:
        return self.port

    # Close the RTP receiver socket and stop receiving audio packets.
    def close(self):
        if self.sock:
            self.sock.close()
            logger.info("🔌 RTP socket closed")