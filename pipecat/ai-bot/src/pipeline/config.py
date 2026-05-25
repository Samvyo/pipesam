import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    # Deepgram settings
    DEEPGRAM_API_KEY: str = os.getenv("DEEPGRAM_API_KEY", "")
    STT_MODEL: str = "nova-2"
    STT_LANGUAGE: str = "en-US"
    TTS_VOICE: str = "aura-asteria-en"

    # Anthropic settings
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
    LLM_MODEL: str = "claude-haiku-4-5-20251001"  
    LLM_MAX_TOKENS: int = 50  

    # Audio settings
    SAMPLE_RATE: int = 16000
    CHUNK: int = 1024

    # System prompt — tells Claude how to behave
    SYSTEM_PROMPT: str = """You are a helpful voice assistant.
    Reply in MAXIMUM 1 short sentence under 20 words.
    Never use bullet points, lists, or special characters."""

    @classmethod
    def validate(cls):
        missing = []
        if not cls.DEEPGRAM_API_KEY:
            missing.append("DEEPGRAM_API_KEY")
        if not cls.ANTHROPIC_API_KEY:
            missing.append("ANTHROPIC_API_KEY")
        if missing:
            raise ValueError(f"Missing in .env: {', '.join(missing)}")
        print("✅ Config OK - all keys found")