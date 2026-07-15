# AI Bot

AI-powered voice bot integrated with MediaSoup.

## Features

* Speech-to-Text (STT) using Deepgram and faster-whisper
* Claude LLM Integration
* Text-to-Speech (TTS)
* Voice Activity Detection (VAD)
* Speaker Identification using SSRC Mapping
* Real-time Transcription
* Live Captions on Video Tiles
* MediaSoup Integration

---

# Running the Bot

## Prerequisites

1. Start the MediaSoup signalling server.
2. Ensure the `.env` file is configured correctly.
3. Activate the Python virtual environment.

```bash
source .venv/bin/activate
```

## Run with Deepgram

Update `.env`:

```env
STT_BACKEND=deepgram
```

Start the bot:

```bash
python main.py
```

The bot will use Deepgram for speech-to-text transcription.

## Run with Faster-Whisper

Update `.env`:

```env
STT_BACKEND=whisper
WHISPER_MODEL=base
```

Start the bot:

```bash
python main.py
```

The bot will use the local Faster-Whisper model for speech-to-text transcription.

## Notes

* MediaSoup and the bot run as separate services and should be started independently.
* No code changes are required to switch between Deepgram and Faster-Whisper.
* The bot automatically loads the selected STT service based on the `STT_BACKEND` value in the `.env` file.
