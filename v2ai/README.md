# AI Meeting Bot — mediasoup Voice/Video AI

OSS Project 3 — An AI-native real-time communications bot that joins a live mediasoup conference as a participant, listens, thinks, and speaks.


# Architecture

```text
                                       +---------------------------------------+
                                       |      OpenTelemetry / Logging          |
                                       |      Traces • Metrics • Logs          |
                                       +-------------------+------------------+
                                                           |
                                                           v

+--------------------+      WebRTC / RTP      +-------------------------------+
|  Meeting Users     | <--------------------> |       mediasoup SFU           |
| Browser / Client   |                        | Workers • Routers • RTP       |
+----------+---------+                        +---------------+---------------+
           ^                                                  |
           |                                                  |
           | Audio / Video                                    |
           |                                                  v
           |                                  +-------------------------------+
           |                                  |      Python AI Meeting Bot    |
           |                                  |       (STT / LLM / TTS)       |
           |                                  +---------------+---------------+
           |                                                  |
           |              +-----------------------------------+------------------------------------+
           |              |                                   |                                    |
           |              v                                   v                                    v
           |     +-------------------+           +----------------------------+          +------------------+
           |     | STT Pipeline      |           | Vision Pipeline            |          | Wake Word / VAD  |
           |     | Speech-to-Text    |           | Screen Analysis            |          | Voice Activity   |
           |     |                   |           |                            |          |                  |
           |     | Deepgram (Primary)|           | Claude Sonnet (Primary)    |          |                  |
           |     | Whisper (Fallback)|           | Claude Haiku (Routine)     |          |                  |
           |     +---------+---------+           | LLaVA (On-Prem Fallback)   |          +--------+---------+
           |               |                     +-------------+--------------+                   |
           |               +---------------------------+-------+-----------------------------------+
           |                                           |
           |                                           v
           |                   +-------------------------------+
           |                   |      PII Scrubber             |
           |                   +---------------+---------------+
           |                                   |
           |                                   v
           |                   +-------------------------------+
           |                   |      Anthropic Claude LLM     |
           |                   | Context • Reasoning • Tools   |
           |                   +---------------+---------------+
           |                                   |
           |          +------------------------+---------------------------+
           |          |                        |                           |
           |          v                        v                           v
           |  Meeting Summary         Action Items              Slide Summaries
           |  Decisions               Q&A                      Context Memory
           |                                   |
           |                                   v
           |                   +-------------------------------+
           |                   |        TTS Orchestrator        |
           |                   +---------------+---------------+
           |                                   |
           |         +-------------------------+-------------------------+
           |         |                         |                         |
           |         v                         v                         v
           |   Cartesia TTS            Deepgram TTS             Kokoro TTS
           |    (Primary)                (Fallback)            (Local Backup)
           |                                   |
           +-----------------------------------+
                                               |
                                               v
                                   RTP Audio streamed back
                                   to mediasoup and users
```

# Features

- 🎙 Real-time AI Meeting Assistant
- 🗣 Wake Word Detection
- 🎤 Voice Activity Detection (VAD)
- 📝 Live Speech-to-Text
  - Deepgram (Primary)
  - Whisper (fallback)
- 🤖 Context-aware Conversations using Claude
- 🧹 PII Scrubbing before LLM processing
- 📋 Automatic Meeting Summaries
- ✅ Action Item Extraction
- 📌 Decision Tracking
- ❓ AI-powered Meeting Q&A
- 🖥 Screen Share Analysis
- 📄 AI Slide Summarization
- 🔊 Multi-provider Text-to-Speech
  - Cartesia (Primary)
  - Deepgram (Fallback)
  - Kokoro (Local Backup)
- 🎧 RTP Audio Streaming with mediasoup
- 🌐 WebRTC Integration
- 📊 OpenTelemetry Distributed Tracing
- 📈 Performance & Latency Monitoring
- 🛡 Graceful STT Failure Handling (Chaos Testing)
- 🐳 Docker-based Deployment


# Prerequisites

Before running the project, ensure the following are installed:

- Git
- Docker
- Docker Compose

> **Note:** This project has been tested on Linux. If required, update the `ANNOUNCED_IP` value in `docker-compose.yml` with your machine's local IP address.


# Quick Start

## 1. Clone the Repository

```bash
git clone <repository-url>

cd opensam

git checkout development

cd v2ai
```

---

## 2. Configure Environment Variables

Create the `.env` file inside the `ai-bot` directory and update the required API keys and configuration.

Example:

```env
# API Keys
DEEPGRAM_API_KEY=xxxxxxxx
ANTHROPIC_API_KEY=xxxxxxxx

# Cartesia
CARTESIA_API_KEY=xxxxxxxx
CARTESIA_VOICE_ID=xxxxxxxx

# Speech-to-Text
STT_BACKEND=deepgram
STT_LANGUAGE=multi
WAKE_WORD=hey bot

# Text-to-Speech
TTS_PROVIDER=cartesia
TTS_VOICE=xxxxxxxx

# Kokoro Fallback
KOKORO_ENABLED=true
KOKORO_VOICE=xxxxxxxx

# Audio
TTS_SAMPLE_RATE=24000
TARGET_DBFS=-18
TTS_TIMEOUT_SECONDS=5

# Welcome Message
WELCOME_MESSAGE=Hello everyone. I am Samvyo, your AI meeting assistant.

# Database
DB_HOST=xxxx
DB_PORT=xxxx
DB_NAME=xxxx
DB_USER=xxxx
DB_PASSWORD=xxxx

# JWT
JWT_SECRET=mysecretkey

# Vision
VISION_PROVIDER=sonnet
VISION_MODEL=claude-haiku-4-5-20251001
VISION_MIN_INTERVAL=5

# LLaVA
LLAVA_MODEL=llava
LLAVA_URL=xxxx

VISION_TIMEOUT=120

SONNET_VISION_MODEL=claude-sonnet-4-5-20250929
```

---

## 3. Start the Application

From the project root, run:

```bash
docker compose up --build
```

---

## 4. Open the Application

Open your browser and navigate to:

```text
https://localhost:5173
```

---

## 6. Join a Meeting

1. Authentication
Generate token:
```text
https://localhost:3000/token?username=yourname&roomId=room1
```
2. Enter the generated token, your **Username**, and **Room ID**.
3. Click **Join**.
4. Allow microphone and camera permissions.
5. Wait for the AI Meeting Bot to join the meeting automatically.

---

## 7. Start Interacting with the Bot

- Say the wake word: **"Hey Bot"**.
- Ask questions or interact naturally with the AI assistant.
- Enable the **"Allow AI to Analyze My Shared Screen"** checkbox before starting screen sharing.
- Share your screen for **AI-powered screen analysis**, slide summarization, and visual Q&A.
- Request meeting summaries, action items, or ask follow-up questions during the meeting.


## Notes

- The AI Meeting Bot runs as an independent service and automatically joins the meeting after startup.
- Speech-to-Text (STT), Text-to-Speech (TTS), and Vision AI providers are configurable through the `.env` file without requiring code changes.
- Set `STT_BACKEND` to choose the Speech-to-Text provider (e.g., Deepgram or Whisper).
- Set `TTS_PROVIDER` to choose the Text-to-Speech provider (e.g., Cartesia, Deepgram, or Kokoro).
- Set `VISION_PROVIDER` and `VISION_MODEL` to configure the Vision AI model (e.g., Claude Sonnet, Claude Haiku, or LLaVA).
- AI-powered screen analysis is available only for users who enable the **"Allow AI to Analyze My Shared Screen"** checkbox. This permission can be enabled or disabled at any time before or during screen sharing.
