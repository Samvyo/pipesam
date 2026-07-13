import av
from loguru import logger


class VP8Decoder:

    def __init__(self):
        self._make_codec()
        self.frame_buffers = {}
        self._got_keyframe = False   # must receive keyframe before decoding

    def _make_codec(self):
        """Create a fresh codec context."""
        self.codec = av.CodecContext.create("vp8", "r")

    def reset(self):
        """Reset decoder state — call when switching streams or after errors."""
        self._make_codec()
        self.frame_buffers.clear()
        self._got_keyframe = False
        logger.info("🔄 VP8Decoder reset")

    def is_keyframe(self, vp8_data: bytes) -> bool:
        """
        Check VP8 frame type from the bitstream.
        VP8 frame header byte 0, bit 0:  0 = keyframe, 1 = inter frame.
        Keyframes also have sync bytes 0x9d 0x01 0x2a at bytes [3:6].
        """
        if len(vp8_data) < 4:
            return False
        return (vp8_data[0] & 0x01) == 0  # bit 0 = 0 means keyframe

    def decode(self, ssrc, payload, marker):

        if ssrc not in self.frame_buffers:
            self.frame_buffers[ssrc] = bytearray()

        self.frame_buffers[ssrc].extend(payload)

        if marker == 0:
            return []   # frame not complete yet, wait for more packets

        complete_frame = bytes(self.frame_buffers[ssrc])
        self.frame_buffers[ssrc].clear()

        # ── Keyframe gate ────────────────────────────────────────────
        # PyAV cannot decode inter frames without seeing a keyframe first.
        # Drop inter frames until we get one.
        if not self._got_keyframe:
            if self.is_keyframe(complete_frame):
                self._got_keyframe = True
                logger.info(
                    f"🔑 First keyframe received! "
                    f"size={len(complete_frame)} ssrc={ssrc} — decoding now"
                )
            else:
                logger.debug(
                    f"⏳ Waiting for keyframe, dropping inter frame "
                    f"size={len(complete_frame)} ssrc={ssrc}"
                )
                return []

        # ── Decode ───────────────────────────────────────────────────
        try:
            packet = av.Packet(complete_frame)
            frames = self.codec.decode(packet)

            if frames:
                logger.debug(
                    f"Decoded {len(frames)} VP8 frame(s)"
                )

            return frames

        except Exception as e:
            logger.warning(f"VP8 decode error (resetting decoder): {e}")
            # Reset so next keyframe starts fresh
            self._got_keyframe = False
            self._make_codec()
            return []