import io

from PIL import Image
from loguru import logger


class JPEGEncoder:

    def encode(self, frame):

        try:
            image = frame.to_image()

            buffer = io.BytesIO()

            image.save(
                buffer,
                format="JPEG",
                quality=85
            )

            jpeg_bytes = buffer.getvalue()

            # logger.info(
            #     f"🖼 JPEG created size={len(jpeg_bytes)} bytes"
            # )

            return jpeg_bytes

        except Exception as e:
            logger.error(
                f"JPEG encode error: {e}"
            )

            return None