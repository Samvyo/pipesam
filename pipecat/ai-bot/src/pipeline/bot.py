import asyncio
import subprocess
import anthropic
import time
from loguru import logger
from deepgram import (
    DeepgramClient,
    LiveOptions,
    LiveTranscriptionEvents,
)
# import pyaudio
import os
from .config import Config
from .rtp_receiver import RTPReceiver
from .rtp_sender import RTPSender, make_rtp_parameters
from .signalling import BotSignalling
import json

os.environ['PYTHONWARNINGS'] = 'ignore'

CHUNK = 1024
RATE = 16000 

conversation_history = []
is_speaking = False       # True while TTS is playing
pipeline_start_time = 0

speech_started = False
speech_start_time = 0


# mic_stream = None

async def ask_claude(user_text: str) -> str:
    try:
        conversation_history.append({
            "role": "user",
            "content": user_text
        })
        logger.info(f"🧠 Asking Claude: {user_text}")
        client = anthropic.Anthropic(
            api_key=Config.ANTHROPIC_API_KEY
        )
        
        llm_start = time.time()

        response = client.messages.create(
            model=Config.LLM_MODEL,
            max_tokens=Config.LLM_MAX_TOKENS,
            system=Config.SYSTEM_PROMPT,
            messages=conversation_history
        )
        reply = response.content[0].text
        conversation_history.append({
            "role": "assistant",
            "content": reply
        })
        llm_end = time.time()
        logger.info(f"⏱️ LLM Latency: {llm_end - llm_start:.2f}s")
        logger.info(f"🤖 Claude: {reply}")
        return reply
    except Exception as e:
        logger.error(f"❌ Claude error: {e}")
        return "Sorry, I had an error."


async def speak(text: str, deepgram: DeepgramClient):
    global is_speaking, pipeline_start_time  # should_interrupt, pipeline_start_time
    is_speaking = True
    logger.info("🔊 Speaking...")

    try:
        tts_start = time.time()
        response = await deepgram.asyncspeak.v("1").stream(
            {"text": text},
            options={
                "model": Config.TTS_VOICE,
                "encoding": "linear16",
                "sample_rate": RATE,
            }
        )

        # Read all audio data at once
        audio_data = response.stream.read()

        tts_end = time.time()
        logger.info(f"⏱️ TTS Latency: {tts_end - tts_start:.2f}s")

        # TTS audio ready — speaker output disabled for now
        # will be sent back to browser via RTP in future
        logger.info(
            f"🔊 TTS ready: {len(audio_data)} bytes"
        )

    except Exception as e:
        logger.error(f"TTS error: {e}")

    finally:
        await asyncio.sleep(1.0)

        is_speaking = False

        pipeline_end = time.time()

        if pipeline_start_time != 0:
            total_latency = (
                pipeline_end - pipeline_start_time
            )

            logger.info(
                f"🚀 Total Pipeline Latency: "
                f"{total_latency:.2f}s"
            )

        pipeline_start_time = 0

        logger.info("🎤 Listening again...")


async def keep_alive(connection):
    """
    Separate task — sends silence to Deepgram
    every 5 seconds to keep connection alive.
    Runs independently from main loop.
    """
    silence = b'\x00' * CHUNK * 2
    while True:
        try:
            # if is_speaking:
            await connection.send(silence)
        except Exception:
            pass
        await asyncio.sleep(0.5)


async def run_bot():
    global is_speaking, pipeline_start_time

    Config.validate()
    logger.info("🚀 Starting pipeline...")

    deepgram = DeepgramClient(Config.DEEPGRAM_API_KEY)
    logger.info("✅ Connected to Deepgram")

    connection = deepgram.listen.asynclive.v("1")

    async def on_transcript(self, result, **kwargs):
        # logger.info("🔥 TRANSCRIPT CALLBACK ENTERED")
        global speech_started
        global speech_start_time
        global pipeline_start_time

        sentence = (
            result.channel.alternatives[0].transcript
        )

        if not sentence:
            return

        # Ignore bot voice during TTS
        if is_speaking:
            return

        # FIRST interim transcript received
        if not speech_started:
            speech_started = True
            speech_start_time = time.time()

       # ONLY process FINAL transcript
        if sentence:

            transcript_received_time = time.time()

            stt_latency = (
                transcript_received_time
                - speech_start_time
            )

            logger.info(f"📝 You said: {sentence}")

            logger.info(
                f"⏱️ STT Duration: "
                f"{stt_latency:.2f}s"
            )

            # Reset for next user speech
            speech_started = False
            speech_start_time = 0

            pipeline_start_time = time.time()

            reply = await ask_claude(sentence)

            await speak(reply, deepgram)

        
    async def on_error(self, error, **kwargs):
        logger.error(f"Deepgram error: {error}")

    connection.on(LiveTranscriptionEvents.Transcript, on_transcript)
    connection.on(LiveTranscriptionEvents.Error, on_error)

    options = LiveOptions(
        model=Config.STT_MODEL,
        language=Config.STT_LANGUAGE,
        smart_format=True,
        interim_results= True,
        encoding="linear16",
        channels=1,
        sample_rate=RATE,
        # utterance_end_ms=2000,
        # vad_events=True, 
        endpointing= 2500,
    )

    success = await connection.start(options)

    if not success:
        logger.error("❌ Deepgram websocket failed")
        return

    logger.info("✅ Deepgram connection started")

    asyncio.create_task(keep_alive(connection))

    await asyncio.sleep(1.0)

    # Start RTP receiver first so port is ready
    rtp = RTPReceiver(host='127.0.0.1', port=55000)
    actual_port = rtp.start()
    logger.info(f"🎧 RTP receiver ready on port {actual_port}")

    # Connect signalling and set up both paths
    signalling = BotSignalling(
        server_url=Config.SIGNALLING_URL,
        token=Config.BOT_TOKEN,
        rtp_port=actual_port
    )
    await signalling.connect()

    # receive path — bot hears browser mic
    await signalling.setup(
        room_id=Config.BOT_ROOM_ID,
        producer_id=Config.BOT_PRODUCER_ID
    )
    await signalling.ready.wait()
    logger.info("✅ Receive path ready — browser audio flowing")

    # send path — browser hears bot tone
    await signalling.setup_send_path()
    logger.info("✅ Send path ready — browser hears bot tone")

    # keep signalling alive in background
    asyncio.create_task(signalling.listen())

    # Start keep-alive as separate background task
    # asyncio.create_task(keep_alive(connection))

    try:
        packet_count = 0
        while True:
            if not is_speaking:
                data = await rtp.read_pcm_chunk()
                await connection.send(data)
            await asyncio.sleep(0.01)

    except KeyboardInterrupt:
        logger.info("👋 Stopped by user")

    finally:
        await connection.finish()
        rtp.close()
        logger.info("🎧 RTP receiver closed")