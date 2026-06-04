import asyncio

import anthropic
import time
from loguru import logger
from deepgram import (
    DeepgramClient,
    LiveOptions,
    LiveTranscriptionEvents,
)
# import audioop
import os
from .config import Config
from .mediasoup_transport import MediasoupTransport

from pipecat.frames.frames import AudioRawFrame
os.environ['PYTHONWARNINGS'] = 'ignore'
import torch
import numpy as np


CHUNK = 1024
RATE = 16000 

# Silero VAD expects 512 samples at 16kHz
VAD_CHUNK_SAMPLES = 512
VAD_CHUNK_BYTES   = VAD_CHUNK_SAMPLES * 2  # int16 = 2 bytes per sample

# speech is confirmed after this many consecutive speech chunks
SPEECH_CONFIRM_CHUNKS  = 2
# silence is confirmed after this many consecutive silence chunks
SILENCE_CONFIRM_CHUNKS = 20  # 20 × 32ms = ~640ms of silence ends utterance


conversation_history: list = []
is_speaking = False       # True while TTS is playing
pipeline_start_time = 0

def load_silero_vad():
    # Load Silero VAD model from torch hub
    # returns (model, get_speech_timestamps utility)
    model, utils = torch.hub.load(
        repo_or_dir='snakers4/silero-vad',
        model='silero_vad',
        force_reload=False,
        trust_repo=True
    )
    logger.info("✅ Silero VAD model loaded")
    return model


def vad_is_speech(model, pcm_bytes: bytes) -> bool:
    # Convert raw 16kHz mono int16 PCM bytes → float32 tensor for Silero
    # Silero expects float32 in range [-1.0, 1.0]
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
    samples = samples / 32768.0
    tensor  = torch.from_numpy(samples)

    # Silero returns confidence 0.0→1.0 that this chunk contains speech
    confidence = model(tensor, RATE).item()
    return confidence > 0.5   # threshold — tune if needed


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


async def speak(text: str, deepgram: DeepgramClient, transport: MediasoupTransport):
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
        frame = AudioRawFrame(
            audio=audio_data,
            sample_rate=RATE,
            num_channels=1
        )
        await transport.output().process_frame(frame, direction=None)

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
        await asyncio.sleep(5)


async def run_bot():
    global is_speaking, pipeline_start_time

    Config.validate()
    logger.info("🚀 Starting pipeline...")

    # Load Silero VAD model once at startup
    vad_model = load_silero_vad()

    deepgram = DeepgramClient(Config.DEEPGRAM_API_KEY)
    logger.info("✅ Connected to Deepgram")

    connection = deepgram.listen.asynclive.v("1")

    transport = MediasoupTransport()
    await transport.start()
    logger.info("✅ MediaSoup transport started")

   
    async def on_transcript(self, result, **kwargs):
        global pipeline_start_time

        if not result.is_final:
            return

        sentence = result.channel.alternatives[0].transcript.strip()
        if not sentence:
            return
        if is_speaking:
            return

        logger.info(f"📝 You said: {sentence}")
        pipeline_start_time = time.time()

        logger.info("🧠 Calling Claude")

        reply = await ask_claude(sentence)

        logger.info("🧠 Claude completed")

        await speak(reply, deepgram, transport)

        
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
        endpointing= 1000,
    )

    success = await connection.start(options)

    if not success:
        logger.error("❌ Deepgram websocket failed")
        return

    logger.info("✅ Deepgram connection started")

    asyncio.create_task(keep_alive(connection))

    async def forward_audio():
        # logger.info("🚀 forward_audio started")
        # VAD state machine
        vad_buffer          = bytearray()  # accumulates incoming PCM
        speech_buffer       = bytearray()  # accumulates speech audio to send
        speech_chunk_count  = 0            # consecutive speech chunks seen
        silence_chunk_count = 0            # consecutive silence chunks seen
        in_speech           = False        # currently inside an utterance

        while True:
            try:
                frame = await transport.input().audio_queue.get()

                pcm = frame.audio
                # logger.info(f"PCM received: {len(pcm)} bytes")
                if not pcm:
                    continue
                if is_speaking:
                    continue
                
                # accumulate into vad_buffer
                vad_buffer.extend(pcm)

                # process in VAD_CHUNK_BYTES sized chunks (512 samples = 32ms)
                while len(vad_buffer) >= VAD_CHUNK_BYTES:
                    chunk = bytes(vad_buffer[:VAD_CHUNK_BYTES])
                    del vad_buffer[:VAD_CHUNK_BYTES]

                    # run Silero VAD on this 32ms chunk
                    # run in executor so it doesn't block the event loop
                    loop = asyncio.get_running_loop()

                    is_speech = await loop.run_in_executor(
                        None,
                        vad_is_speech,
                        vad_model,
                        chunk
                    )
                   

                    if is_speech:
                        silence_chunk_count  = 0
                        speech_chunk_count  += 1

                        # always buffer speech audio
                        speech_buffer.extend(chunk)

                        # confirm speech onset after SPEECH_CONFIRM_CHUNKS
                        if not in_speech and speech_chunk_count >= SPEECH_CONFIRM_CHUNKS:
                            in_speech = True
                            logger.info("🎤 VAD: speech started")

                        if in_speech:
                            await connection.send(chunk)

                    else:
                        speech_chunk_count   = 0
                        silence_chunk_count += 1

                        if in_speech:
                            # still buffer during short silences (part of speech)
                            speech_buffer.extend(chunk)

                            # end utterance after SILENCE_CONFIRM_CHUNKS of silence
                            if silence_chunk_count >= SILENCE_CONFIRM_CHUNKS:
                                in_speech           = False
                                silence_chunk_count = 0
                                logger.info(
                                    f"🔇 VAD: speech ended — "
                                    f"sending {len(speech_buffer)} bytes to Deepgram"
                                )
 
                                try:
                                    await connection.finalize()
                                    logger.info("✅ Deepgram finalize sent")
                                except Exception as e:
                                    logger.error(f"Finalize error: {e}")

                                speech_buffer.clear()
                                            
                                
                        else:
                            # silence outside speech — discard, don't send to Deepgram
                            pass

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Audio forward error: {e}")

    forward_task = asyncio.create_task(forward_audio())

    # logger.info("🚀 forward_audio task created")

    try:
        await asyncio.Event().wait()
    except KeyboardInterrupt:
        logger.info("👋 Stopped by user")
    finally:
        forward_task.cancel()
        await connection.finish()
        await transport.stop()
        logger.info("✅ Bot shut down cleanly")