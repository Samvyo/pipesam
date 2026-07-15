import base64
import httpx

from loguru import logger

from .config import Config


class LlavaVision:

    async def analyse(
        self,
        jpeg_bytes: bytes,
        prompt: str,
    ) -> str:

        image = base64.b64encode(jpeg_bytes).decode()

        payload = {
            "model": Config.LLAVA_MODEL,
            "prompt": prompt,
            "images": [image],
            "stream": False,
        }


        try:

            async with httpx.AsyncClient(
                timeout=httpx.Timeout(
                    connect=10,
                    read=Config.VISION_TIMEOUT,
                    write=30,
                    pool=30,
                )
            ) as client:

                response = await client.post(
                    Config.LLAVA_URL,
                    json=payload,
                )

                response.raise_for_status()
                logger.info("✅ Vision Success | Provider=LLAVA")

            return response.json()["response"]

        except Exception as e:
            logger.exception(e)
            raise