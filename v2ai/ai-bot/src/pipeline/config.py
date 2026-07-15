import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

class Config:
     # ── Speech-to-Text (STT) ─────────────────────────────────────────────────
    DEEPGRAM_API_KEY: str = os.getenv("DEEPGRAM_API_KEY", "")
    STT_MODEL: str = "nova-2"
    STT_LANGUAGE: str = os.getenv("STT_LANGUAGE", "multi")  # Default to "multi" for automatic language detection
    # STT Backend Selection
    STT_BACKEND: str = os.getenv("STT_BACKEND", "deepgram")
    WHISPER_MODEL: str = os.getenv("WHISPER_MODEL", "base")

    # ── Large Language Model (LLM) ───────────────────────────────────────────
    # Anthropic settings
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
    LLM_MODEL: str = "claude-haiku-4-5-20251001"  
    LLM_MAX_TOKENS: int = 300
    # Rolling context window — how many turns to keep
    LLM_CONTEXT_WINDOW: int = int(os.getenv("LLM_CONTEXT_WINDOW", "10"))
    # Rate limiting — seconds between LLM calls per user
    LLM_RATE_LIMIT_SECONDS: float = float(os.getenv("LLM_RATE_LIMIT_SECONDS", "2.0")) 

    VISION_PROVIDER = os.getenv(
        "VISION_PROVIDER",
        "sonnet"
    )

    SONNET_VISION_MODEL = os.getenv(
        "SONNET_VISION_MODEL",
        "claude-sonnet-4-5-20250929"
    )

    VISION_MODEL = os.getenv(
        "VISION_MODEL",
        "claude-haiku-4-5-20251001"
    )

    LLAVA_MODEL = os.getenv(
        "LLAVA_MODEL",
        "llava"
    )

    LLAVA_URL = os.getenv(
        "LLAVA_URL",
        "http://host.docker.internal:11434/api/generate"
    )

    VISION_TIMEOUT = float(
        os.getenv(
            "VISION_TIMEOUT",
            "60"
        )
    )

    VISION_MIN_INTERVAL = float(
        os.getenv(
            "VISION_MIN_INTERVAL",
            "5"
        )
    )


    # ── Wake Word & Meeting Context ──────────────────────────────────────────
    # Wake word
    WAKE_WORD: str = os.getenv("WAKE_WORD", "hey bot")
    # Meeting context
    MEETING_TITLE: str = os.getenv("MEETING_TITLE", "Team Meeting")
    

      # ── Audio Input Settings ─────────────────────────────────────────────────
    SAMPLE_RATE: int = 16000
    CHUNK: int = 1024

    # ── Signalling / WebRTC ──────────────────────────────────────────────────
    SIGNALLING_URL: str = os.getenv("SIGNALLING_URL", "wss://192.168.29.128:3000")
    BOT_TOKEN: str = os.getenv("BOT_TOKEN", "")
    BOT_ROOM_ID: str = os.getenv("BOT_ROOM_ID", "testroom")
    # BOT_PRODUCER_ID: str = os.getenv("BOT_PRODUCER_ID", "")

    WELCOME_MESSAGE: str = os.getenv(
        "WELCOME_MESSAGE",
        "Hello everyone. I am Samvyo, your AI meeting assistant."
    )
     # ── Text-to-Speech (TTS) — Provider Selection ────────────────────────────
    # Primary: Cartesia (cloud, low latency ~400ms)
    # Fallback 1: Deepgram (cloud)
    # Fallback 2: Kokoro (local, no network needed)
    TTS_PROVIDER: str = os.getenv("TTS_PROVIDER", "cartesia")
    # ── Deepgram TTS ──────────────────────────────────────────────
    TTS_VOICE: str = os.getenv("TTS_VOICE", "aura-asteria-en")

     # ── Cartesia TTS ─────────────────────────────────────────────────────────
    CARTESIA_API_KEY: str = os.getenv("CARTESIA_API_KEY", "")
    CARTESIA_VOICE_ID: str = os.getenv("CARTESIA_VOICE_ID", "")
    CARTESIA_MODEL: str = os.getenv("CARTESIA_MODEL", "sonic-2")


    # ── Kokoro TTS (local fallback) ──────────────────────────────────────────
    KOKORO_ENABLED: bool = os.getenv("KOKORO_ENABLED", "true").lower() == "true"
    KOKORO_VOICE: str = os.getenv("KOKORO_VOICE", "af_heart")

    # ── TTS Audio Output Settings ────────────────────────────────────────────
    TTS_SAMPLE_RATE: int = int(os.getenv("TTS_SAMPLE_RATE", "24000"))
    TARGET_DBFS: float = float(os.getenv("TARGET_DBFS", "-18"))

    # Failover settings
    TTS_TIMEOUT_SECONDS: float = float(os.getenv("TTS_TIMEOUT_SECONDS", "5"))


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
    - When the user asks for a meeting summary, use the summarise_meeting tool
    - When the user asks for action items, always call the extract_action_items tool first.
    - The extract_action_items tool contains the meeting transcript.
    - Do not answer from memory.
    - After receiving the transcript from the tool, extract action items with owner, task and due date.
    - Always format each action item exactly like this, one per line:
      **Owner:** <person name or "Unknown">
      **Task:** <what needs to be done>
      **Due Date:** <due date or "Not specified">
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

        if not cls.ANTHROPIC_API_KEY:
            missing.append("ANTHROPIC_API_KEY")
        if not cls.BOT_TOKEN:
            missing.append("BOT_TOKEN")
        if cls.TTS_PROVIDER == "cartesia":
            if not cls.CARTESIA_API_KEY:
                missing.append("CARTESIA_API_KEY")

            if not cls.CARTESIA_VOICE_ID:
                missing.append("CARTESIA_VOICE_ID")
        if missing:
            raise ValueError(f"Missing in .env: {', '.join(missing)}")
        print("✅ Config OK - all keys found")