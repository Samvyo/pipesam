import asyncio
import base64
import time

import httpx
from loguru import logger

from .config import Config
from .llava_vision import LlavaVision


class VisionAnalyser:

    def __init__(self):
        self.api_key = Config.ANTHROPIC_API_KEY
        self.model = Config.VISION_MODEL
        self.min_interval = Config.VISION_MIN_INTERVAL
        self._last_call = 0.0
        self.latest_jpeg = None

        self.previous_jpeg = None
        self.last_slide_summary = ""
        self.last_summary_time = 0.0

        self.screen_share_active = False
        self.llava = LlavaVision()
        self._vision_lock = asyncio.Lock()

        self.last_provider = None

    def update_frame(
        self,
        jpeg_bytes: bytes,
    ):
        self.latest_jpeg = jpeg_bytes


    def get_latest_frame(self):

        logger.info(
            f"📤 Reading frame | Vision ID={id(self)} | "
            f"available={self.latest_jpeg is not None}"
        )

        return self.latest_jpeg
    
    def clear_frame(self):
        logger.info("🧹 Clearing latest screen frame")

        self.latest_jpeg = None
        self.previous_jpeg = None
        
    def has_slide_changed(
        self,
        jpeg_bytes: bytes,
    ) -> bool:

        if self.previous_jpeg is None:
            self.previous_jpeg = jpeg_bytes
            return True

        if jpeg_bytes != self.previous_jpeg:
            self.previous_jpeg = jpeg_bytes
            return True

        return False

    async def _call(
        self,
        jpeg_bytes: bytes,
        prompt: str,
    ) -> str:

        gap = self.min_interval - (
            time.time() - self._last_call
        )

        if gap > 0:
            await asyncio.sleep(gap)

        self._last_call = time.time()

        logger.info(
            f"Primary Vision Provider: {Config.VISION_PROVIDER}"
        )

        image_b64 = base64.b64encode(
            jpeg_bytes
        ).decode("utf-8")

        async with self._vision_lock:

            # Provider order
            if Config.VISION_PROVIDER == "sonnet":
                providers = ["sonnet", "llava", "haiku"]

            elif Config.VISION_PROVIDER == "llava":
                providers = ["llava", "sonnet", "haiku"]

            elif Config.VISION_PROVIDER == "haiku":
                providers = ["haiku", "sonnet", "llava"]

            else:
                raise ValueError(
                    f"Unsupported vision provider: {Config.VISION_PROVIDER}"
                )

            for provider in providers:

                try:

                    if provider == "sonnet":

                        logger.info("Trying Claude Sonnet")

                        answer = await self._call_sonnet(
                            image_b64,
                            prompt,
                        )

                        self.last_provider = "sonnet"

                        return answer

                    elif provider == "llava":

                        logger.info("Trying LLaVA")

                        answer = await self.llava.analyse(
                            jpeg_bytes,
                            prompt,
                        )

                        self.last_provider = "llava"

                        return answer

                    elif provider == "haiku":

                        logger.info("Trying Claude Haiku")

                        answer = await self._call_haiku(
                            image_b64,
                            prompt,
                        )

                        self.last_provider = "haiku"

                        return answer

                except Exception as e:

                    logger.warning(
                        f"{provider} failed: {e}"
                    )

            raise RuntimeError(
                "All Vision providers failed."
            )
    async def _call_sonnet(
        self,
        image_b64: str,
        prompt: str,
    ) -> str:

        payload = {
            "model": Config.SONNET_VISION_MODEL,
            "max_tokens": 300,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": image_b64,
                            },
                        },
                        {
                            "type": "text",
                            "text": prompt,
                        },
                    ],
                }
            ],
        }

        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        async with httpx.AsyncClient(
            timeout=Config.VISION_TIMEOUT
        ) as client:

            response = await client.post(
                "https://api.anthropic.com/v1/messages",
                json=payload,
                headers=headers,
            )

            response.raise_for_status()

        logger.info("✅ Vision Success | Provider=SONNET")

        return response.json()["content"][0]["text"]
    
    async def _call_haiku(
        self,
        image_b64: str,
        prompt: str,
    ) -> str:

        payload = {
            "model": Config.VISION_MODEL,
            "max_tokens": 300,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": image_b64,
                            },
                        },
                        {
                            "type": "text",
                            "text": prompt,
                        },
                    ],
                }
            ],
        }

        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        async with httpx.AsyncClient(
            timeout=Config.VISION_TIMEOUT
        ) as client:

            response = await client.post(
                "https://api.anthropic.com/v1/messages",
                json=payload,
                headers=headers,
            )

            response.raise_for_status()

        logger.info("✅ Vision Success | Provider=HAIKU")

        return response.json()["content"][0]["text"]

    async def describe_screen(
        self,
        jpeg_bytes: bytes,
    ) -> str:

        return await self._call(
            jpeg_bytes,
            (
                "You are an AI meeting assistant. "
                "Describe what is visible on the shared screen "
                "in one or two short sentences."
            ),
        )

    async def summarise_slide(
        self,
        jpeg_bytes: bytes,
    ) -> str:

        return await self._call(
            jpeg_bytes,
            (
                "You are an AI meeting assistant. "
                "Summarise this presentation slide "
                "in two or three concise sentences."
            ),
        )