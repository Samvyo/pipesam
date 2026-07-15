import asyncio
import sys
from loguru import logger

# Configure clean log format
logger.remove()  # remove default logger
logger.add(
    sys.stderr,
    format="<green>{time:HH:mm:ss}</green> | <level>{level}</level> | {message}",
    level="INFO"
)

async def main():
    try:
        # Import here so errors are caught cleanly
        from src.pipeline.bot import run_bot

        logger.info("=== Pipecat Voice Pipeline ===")
        logger.info("Mic → Deepgram STT → Echo → Speaker")
        logger.info("==============================")

        await run_bot()

    except ValueError as e:
        # Config errors (missing API key)
        logger.error(f"Config error: {e}")
        sys.exit(1)

    except Exception as e:
        logger.exception(f"Unexpected error: {e}")
        sys.exit(1)

# asyncio.run() starts the async event loop
# Python needs this to run async functions
if __name__ == "__main__":
    asyncio.run(main())