FROM node:20

WORKDIR /app

RUN apt-get update && \
    apt-get install -y \
      ffmpeg \
      python3 \
      python3-pip \
      python3-venv \
      python3-full \
      curl \
      git \
      build-essential \
      portaudio19-dev \
      libportaudio2 \
      libasound2-dev \
      libsndfile1 && \
    rm -rf /var/lib/apt/lists/*

# Create venv — safe from volume mount
RUN python3 -m venv /opt/venv
ENV VIRTUAL_ENV="/opt/venv"
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --upgrade pip

RUN pip install --retries 10 --timeout 120 \
    psycopg2-binary \
    "torch>=2.0.0,<3.0.0" \
    torchaudio \
    numpy \
    scipy \
    soundfile \
    pillow \
    pydub \
    loguru \
    python-dotenv \
    aiohttp \
    requests \
    pydantic \
    "websockets>=12.0" \
    "httpx==0.27.2" \
    anthropic \
    opuslib \
    cartesia \
    kokoro \
    av \
    spacy \
    opentelemetry-api==1.24.0 \
    opentelemetry-sdk==1.24.0 \
    opentelemetry-exporter-otlp-proto-grpc==1.24.0 \
    "deepgram-sdk>=3.0.0,<4.0.0" \
    "pipecat-ai[deepgram,anthropic,silero,cartesia]==0.0.47"

RUN python3 -m spacy download en_core_web_sm


# Fail at build time if torch missing — not at runtime
RUN python3 -c "from opentelemetry import trace; print('✅ OpenTelemetry installed')"
RUN python3 -c "import spacy; spacy.load('en_core_web_sm'); print('✅ spaCy model installed')"
RUN python3 -c "import torch; print('✅ torch', torch.__version__)"
RUN python3 -c "from PIL import Image; print('✅ Pillow installed')"
RUN python3 -c "import torch"
RUN python3 -c "import torchaudio"
RUN python3 -c "import anthropic"
RUN python3 -c "import cartesia"
RUN python3 -c "import deepgram"
RUN python3 -c "import numpy"
RUN python3 -c "import websockets"
RUN python3 -c "from kokoro import KPipeline"
RUN python3 -c "import av; print('✅ av', av.__version__)"

# Node app
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000

# server.js is at root of server/ folder — build context is ./server
CMD ["node", "server.js"]