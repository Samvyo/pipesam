import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    # Deepgram settings
    DEEPGRAM_API_KEY: str = os.getenv("DEEPGRAM_API_KEY", "")
    STT_MODEL: str = "nova-2"
    STT_LANGUAGE: str = os.getenv("STT_LANGUAGE", "multi")  # Default to "multi" for automatic language detection
    TTS_VOICE: str = "aura-asteria-en"

    # STT Backend Selection
    STT_BACKEND: str = os.getenv("STT_BACKEND", "deepgram")
    WHISPER_MODEL: str = os.getenv("WHISPER_MODEL", "base")

    # Anthropic settings
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
    LLM_MODEL: str = "claude-haiku-4-5-20251001"  
    LLM_MAX_TOKENS: int = 300
    # Wake word
    WAKE_WORD: str = os.getenv("WAKE_WORD", "hey bot")

    # Meeting context
    MEETING_TITLE: str = os.getenv("MEETING_TITLE", "Team Meeting")

    # Rolling context window — how many turns to keep
    LLM_CONTEXT_WINDOW: int = int(os.getenv("LLM_CONTEXT_WINDOW", "10"))

    # Rate limiting — seconds between LLM calls per user
    LLM_RATE_LIMIT_SECONDS: float = float(os.getenv("LLM_RATE_LIMIT_SECONDS", "2.0")) 

    # Audio settings
    SAMPLE_RATE: int = 16000
    CHUNK: int = 1024

    # Signalling settings
    SIGNALLING_URL: str = os.getenv("SIGNALLING_URL", "wss://192.168.29.128:3000")
    BOT_TOKEN: str = os.getenv("BOT_TOKEN", "")
    BOT_ROOM_ID: str = os.getenv("BOT_ROOM_ID", "testroom")
    # BOT_PRODUCER_ID: str = os.getenv("BOT_PRODUCER_ID", "")

    @staticmethod
    def build_system_prompt(participants: list, meeting_title: str) -> str:
        from datetime import datetime
        now   = datetime.now().strftime("%Y-%m-%d %H:%M")
        names = ", ".join(participants) if participants else "unknown"
        return f"""You are Samvyo, an AI meeting assistant.

    Meeting: {meeting_title}
    Time: {now}
    Participants: {names}

    Your behaviour:
    - Answer questions directly and helpfully
    - Keep responses short — 1 to 3 sentences maximum
    - You can summarise the meeting when asked
    - You are professional, concise and friendly
    - You remember the conversation history of this meeting

    Constraints:
    - Never make up facts
    - If you do not know something, say so
    - Do not repeat yourself
    - Do not ask the user to repeat themselves or use any wake word
    """

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