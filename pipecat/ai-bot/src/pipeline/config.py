import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    # Deepgram settings
    DEEPGRAM_API_KEY: str = os.getenv("DEEPGRAM_API_KEY", "")
    STT_MODEL: str = "nova-2"
    STT_LANGUAGE: str = "en-US"
    TTS_VOICE: str = "aura-asteria-en"

    # STT Backend Selection
    STT_BACKEND: str = os.getenv("STT_BACKEND", "deepgram")
    WHISPER_MODEL: str = os.getenv("WHISPER_MODEL", "base")

    # Anthropic settings
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
    LLM_MODEL: str = "claude-haiku-4-5-20251001"  
    LLM_MAX_TOKENS: int = 50  

    # Audio settings
    SAMPLE_RATE: int = 16000
    CHUNK: int = 1024

    # Signalling settings
    SIGNALLING_URL: str = os.getenv("SIGNALLING_URL", "wss://10.161.40.137:3000")
    BOT_TOKEN: str = os.getenv("BOT_TOKEN", "")
    BOT_ROOM_ID: str = os.getenv("BOT_ROOM_ID", "testroom")
    # BOT_PRODUCER_ID: str = os.getenv("BOT_PRODUCER_ID", "")

    # System prompt — tells Claude how to behave
    SYSTEM_PROMPT: str = """You are a helpful voice assistant.
    Reply in MAXIMUM 1 short sentence under 20 words.
    Never use bullet points, lists, or special characters."""

    @classmethod
    def validate(cls):
        missing = []
        if cls.STT_BACKEND == "deepgram":
            if not cls.DEEPGRAM_API_KEY:
                missing.append("DEEPGRAM_API_KEY")

        # if cls.STT_BACKEND == "whisper":
        #     if not cls.WHISPER_MODEL:
        #         missing.append("WHISPER_MODEL")
        if not cls.ANTHROPIC_API_KEY:
            missing.append("ANTHROPIC_API_KEY")
        if not cls.BOT_TOKEN:
            missing.append("BOT_TOKEN")
        # if not cls.BOT_PRODUCER_ID:
        #     missing.append("BOT_PRODUCER_ID")
        if missing:
            raise ValueError(f"Missing in .env: {', '.join(missing)}")
        print("✅ Config OK - all keys found")