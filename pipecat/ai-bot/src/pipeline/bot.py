import asyncio
import anthropic
import time
from loguru import logger
# from deepgram import (
#     DeepgramClient,
#     LiveOptions,
#     LiveTranscriptionEvents,
# )
# import audioop
import os
from .config import Config
from .deepgram_stt import DeepgramSTT
from .whisper_stt import WhisperSTT
from .mediasoup_transport import MediasoupTransport

from .tts.cartesia_tts import CartesiaTTS
from .tts.deepgram_tts import DeepgramTTS

from .audio_utils import normalize_audio

from pipecat.frames.frames import AudioRawFrame
os.environ['PYTHONWARNINGS'] = 'ignore'
import torch
import numpy as np

import re


CHUNK = 1024
RATE = 16000  
# TTS_SAMPLE_RATE = 24000 

# Silero VAD expects 512 samples at 16kHz
VAD_CHUNK_SAMPLES = 512
VAD_CHUNK_BYTES   = VAD_CHUNK_SAMPLES * 2  # int16 = 2 bytes per sample

# speech is confirmed after this many consecutive speech chunks
SPEECH_CONFIRM_CHUNKS  = 2
# silence is confirmed after this many consecutive silence chunks
SILENCE_CONFIRM_CHUNKS = 20  # 20 × 32ms = ~640ms of silence ends utterance


conversation_history: list = []
transcript_log: list = []

# current TTS task — so we can cancel it on interrupt
current_tts_task = None

# participants in the room — updated from signalling
room_participants: list = []

is_speaking = False       # True while TTS is playing
pipeline_start_time = 0

# all currently-running speak_sentence tasks (for interruption)
active_tts_tasks: list = []

# queue of sentences waiting to be spoken — played one at a time
tts_queue: asyncio.Queue = asyncio.Queue()
tts = None

last_llm_token_time = None

first_audio_measured= False


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

def contains_wake_word(text: str) -> bool:
    """
    Check if transcript contains the wake word.
    Removes punctuation before checking so
    'Hey, bot' matches wake word 'hey bot'.
    """
    cleaned = re.sub(r'[^\w\s]', '', text.lower().strip())
    wake    = re.sub(r'[^\w\s]', '', Config.WAKE_WORD.lower().strip())
    
    result = wake in cleaned
    logger.info(f"🔍 Wake word check: '{wake}' in '{cleaned}' → {result}")
    return result


def get_text_after_wake_word(text: str) -> str:
    """
    Extract question after wake word.
    'Hey, bot. What is Python?' → 'What is Python?'
    """
    # find wake word position ignoring punctuation
    cleaned = re.sub(r'[^\w\s]', '', text.lower())
    wake    = re.sub(r'[^\w\s]', '', Config.WAKE_WORD.lower())
    
    idx = cleaned.find(wake)
    if idx == -1:
        return text
    
    # calculate character position in original text
    # count wake word length + some buffer for punctuation
    wake_end = idx + len(wake)
    
    # now find same position in original text
    clean_chars = 0
    orig_pos    = 0
    for i, ch in enumerate(text.lower()):
        if re.match(r'[\w\s]', ch):
            if clean_chars >= wake_end:
                orig_pos = i
                break
            clean_chars += 1
    
    after = text[orig_pos:].strip().lstrip(",.!?- ")
    return after if after else text

def trim_conversation_history():
    """
    Keep only the last N turns in conversation history.
    This prevents the context window from growing forever.
    N = Config.LLM_CONTEXT_WINDOW (default 10 turns = 20 messages)
    """
    global conversation_history
    max_messages = Config.LLM_CONTEXT_WINDOW * 2  # each turn = user + assistant
    if len(conversation_history) > max_messages:
        # keep the most recent messages
        conversation_history = conversation_history[-max_messages:]
        logger.info(
            f"🔄 Context trimmed to {len(conversation_history)} messages"
        )

summarise_tool = {
    "name": "summarise_meeting",
    "description": "Summarize the meeting discussion so far based on the transcript.",
    "input_schema": {
        "type": "object",
        "properties": {},
        "required": []
    }
}

def generate_meeting_summary() -> str:
    """Build a simple summary string from transcript_log."""
    if not transcript_log:
        return "No conversation has happened yet."

    lines = []
    for entry in transcript_log:
        lines.append(f"{entry['speaker']}: {entry['text']}")

    return "Meeting transcript so far:\n" + "\n".join(lines)


async def ask_claude_streaming(user_text: str, transport: MediasoupTransport):
    """
    Stream Claude response token by token.
    Send each complete sentence to TTS immediately.
    Supports tool use (summarise_meeting).
    """
    global current_tts_task
    global last_llm_token_time
    global first_audio_measured

    first_audio_measured = False

    conversation_history.append({
        "role": "user",
        "content": user_text
    })
    trim_conversation_history()

    logger.info(f"🧠 Asking Claude (streaming): {user_text}")

    client = anthropic.Anthropic(api_key=Config.ANTHROPIC_API_KEY)

    system_prompt = Config.build_system_prompt(
        participants=room_participants,
        meeting_title=Config.MEETING_TITLE
    )

    sentence_endings = re.compile(r'[.!?]')
    llm_start = time.time()

    # loop runs at most twice: once for initial reply, again if a tool was called
    while True:
        full_reply = ""
        sentence_buffer = ""
        tool_calls = []
        first_token_logged = False

        try:
            with client.messages.stream(
                model=Config.LLM_MODEL,
                max_tokens=Config.LLM_MAX_TOKENS,
                system=system_prompt,
                tools=[summarise_tool],
                messages=conversation_history
            ) as stream:

                for event in stream:
                    if event.type == "content_block_delta" and event.delta.type == "text_delta":
                        if not first_token_logged:
                            first_token_logged = True
                            first_token_time = time.time()
                            logger.info(f"⚡ First token latency: {time.time() - llm_start:.2f}s")

                        text_chunk = event.delta.text
                        last_llm_token_time = time.time()

                        full_reply += text_chunk
                        sentence_buffer += text_chunk

                        phrase_endings = re.compile(r'[.!?;:]')

                        if phrase_endings.search(sentence_buffer):

                            parts = re.split(r'([.!?;:])', sentence_buffer)

                            while len(parts) >= 2:

                                phrase = (parts[0] + parts[1]).strip()

                                if phrase:
                                    tts_send_time = time.time()

                                    logger.info(
                                        f"🔊 Queuing TTS chunk: {phrase} | "
                                        f"⚡ first-token→TTS-queue latency: "
                                        f"{(tts_send_time - first_token_time)*1000:.0f}ms"
                                    )

                                    tts_queue.put_nowait(phrase)

                                parts = parts[2:]

                            sentence_buffer = "".join(parts)

                    if event.type == "content_block_stop":
                        block = getattr(event, "content_block", None)
                        if block and block.type == "tool_use":
                            tool_calls.append(block)

                if sentence_buffer.strip():
                    tts_queue.put_nowait(sentence_buffer.strip())

                final_message = stream.get_final_message()

            conversation_history.append({
                "role": "assistant",
                "content": final_message.content
            })

            if not tool_calls:
                logger.info(f"⏱️ Total LLM Latency: {time.time() - llm_start:.2f}s")
                logger.info(f"🤖 Claude: {full_reply}")
                break

            # execute requested tool(s) and send result back for final reply
            tool_results = []
            for tool_call in tool_calls:
                if tool_call.name == "summarise_meeting":
                    summary_text = generate_meeting_summary()
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_call.id,
                        "content": summary_text
                    })

            conversation_history.append({
                "role": "user",
                "content": tool_results
            })
            # loop again -> Claude streams its final spoken reply using the tool result

        except Exception as e:
            logger.error(f"❌ Claude streaming error: {e}")
            tts_queue.put_nowait("Sorry, I had a problem. Could you repeat that?")
            break

async def speak_sentence(text: str, transport: MediasoupTransport):
    global is_speaking, last_llm_token_time, first_audio_measured

    if not text or len(text.strip()) < 2:
        return

    is_speaking = True
    task = asyncio.current_task()
    active_tts_tasks.append(task)
    logger.info(f"🔊 Speaking: '{text}'")

    try:
        tts_start = time.time()

        # ── STEP 1: collect all chunks from TTS ──────────────────
        raw_chunks = []
        first_chunk_received = False

        async for audio_data in tts.stream(text):
            if not first_chunk_received:
                first_chunk_received = True

                # latency logging on first chunk arriving
                if not first_audio_measured and last_llm_token_time:
                    first_audio_measured = True
                    logger.info(
                        f"🎤 TTS-to-First-Audio Latency: "
                        f"{(time.time() - last_llm_token_time) * 1000:.0f}ms"
                    )
                logger.info(f"⚡ First audio latency: {(time.time() - tts_start) * 1000:.0f}ms")

            raw_chunks.append(audio_data)

        # ── STEP 2: normalize ONCE on full audio ─────────────────
        full_audio = b"".join(raw_chunks)
        full_audio = normalize_audio(full_audio, Config.TARGET_DBFS)  # ← once, not 78 times

        # ── STEP 3: send to RTP in small chunks ──────────────────
        chunk_size = 1024 * 2
        sleep_per_chunk = 1024 / Config.TTS_SAMPLE_RATE

        for i in range(0, len(full_audio), chunk_size):
            chunk = full_audio[i:i + chunk_size]
            frame = AudioRawFrame(
                audio=chunk,
                sample_rate=Config.TTS_SAMPLE_RATE,
                num_channels=1
            )
            await transport.output().process_frame(frame, direction=None)
            await asyncio.sleep(sleep_per_chunk)

    except asyncio.CancelledError:
        logger.info("🛑 TTS cancelled — interrupt")
    except Exception as e:
        logger.error(f"TTS error: {e}")
    finally:
        is_speaking = False
        if task in active_tts_tasks:
            active_tts_tasks.remove(task)
        logger.info("🎤 Listening again...")
async def tts_worker(transport: MediasoupTransport):
    """
    Single worker — pulls sentences off the queue and speaks them
    one at a time, so audio never overlaps and stays at normal speed.
    """
    while True:
        text = await tts_queue.get()
        try:
            await speak_sentence(text, transport)

            # natural pause between sentences
            await asyncio.sleep(0.25)

        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"TTS worker error: {e}")
        finally:
            tts_queue.task_done()


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

async def comfort_noise_worker(transport):

    logger.info("🎧 Comfort noise worker started")

    while True:

        try:

            if not is_speaking:

                logger.debug("🔇 Sending comfort noise")

                silence = b"\x00" * (1024 * 2)

                frame = AudioRawFrame(
                    audio=silence,
                    sample_rate=Config.TTS_SAMPLE_RATE,
                    num_channels=1
                )

                await transport.output().process_frame(
                    frame,
                    direction=None
                )

            await asyncio.sleep(
                1024 / Config.TTS_SAMPLE_RATE
            )

        except asyncio.CancelledError:
            break

        except Exception as e:
            logger.error(
                f"Comfort noise error: {e}"
            )

async def run_bot():
    global is_speaking
    global pipeline_start_time
    global room_participants
    global current_tts_task
    global tts

    Config.validate()
    logger.info("🚀 Starting pipeline...")
    logger.info(f"🎙️ Wake word: '{Config.WAKE_WORD}'")

    # Load Silero VAD model once at startup
    vad_model = load_silero_vad()

    if Config.STT_BACKEND == "whisper":
        logger.info("🎙️ Using Whisper")
        stt = WhisperSTT()

    else:
        logger.info("🎙️ Using Deepgram")
        stt = DeepgramSTT()

    if Config.TTS_PROVIDER == "cartesia":
        logger.info("🔊 Using Cartesia TTS")
        tts = CartesiaTTS()
        await tts.connect() 

    elif Config.TTS_PROVIDER == "kokoro":
        logger.info("🔊 Using Kokoro TTS")
        from .tts.kokoro_tts import KokoroTTS
        tts = KokoroTTS()

    else:
        logger.info("🔊 Using Deepgram TTS")
        tts = DeepgramTTS()

    transport = MediasoupTransport()
    await transport.start()
    logger.info("✅ MediaSoup transport started")

    asyncio.create_task(tts_worker(transport))

    asyncio.create_task(comfort_noise_worker(transport))

    # update participants list from signalling
    # this runs every time a peer joins or leaves
    async def refresh_participants():
        while True:
            try:
                peers = list(
                    transport._signalling.ssrc_to_peer.values()
                )
                # add any peers from the room peer list
                room_participants.clear()
                room_participants.extend(set(peers))
            except Exception:
                pass
            await asyncio.sleep(5)

    asyncio.create_task(refresh_participants())

    # transcript callback
    async def on_transcript(text: str, confidence: float):
        global pipeline_start_time, current_tts_task

        if not text:
            return
        
        logger.info(f"📝 Transcript: {text}")
        logger.info(f"🎯 Confidence: {confidence:.2f}")

        if confidence < 0.70:
            logger.warning(f"❌ Transcript rejected (confidence={confidence:.2f})")
            return

        # ── INTERRUPT HANDLING (any speech while bot is talking) ───
        global is_speaking, active_tts_tasks
        if is_speaking:
            logger.info(f"🛑 Interrupt detected (any speech) — cancelling TTS: '{text}'")
            for t in active_tts_tasks:
                if not t.done():
                    t.cancel()
            active_tts_tasks.clear()

            # drop any sentences still waiting in the queue
            while not tts_queue.empty():
                try:
                    tts_queue.get_nowait()
                    tts_queue.task_done()
                except asyncio.QueueEmpty:
                    break

            is_speaking = False
            await asyncio.sleep(0.1)

        # ── WAKE WORD CHECK ───────────────────────────────────────
        if not contains_wake_word(text):
            logger.info(f"💤 No wake word — ignoring: '{text}'")
            return

        logger.info(f"🔔 Wake word detected in: '{text}'")

        # ── EXTRACT QUESTION ──────────────────────────────────────
        question = get_text_after_wake_word(text)
        if not question or question.lower() == text.lower():
            question = "hey bot, I heard you. How can I help?"

        logger.info(f"❓ Question for Claude: '{question}'")

        transcript_event = {
            "speaker": transport._signalling.current_speaker,
            "text": text,
            "confidence": confidence,
            "ts": time.time()
        }
        transcript_log.append(transcript_event)

        await transport._signalling.send_transcript(
            speaker=transcript_event["speaker"],
            text=transcript_event["text"],
            confidence=transcript_event["confidence"],
            ts=transcript_event["ts"]
        )

        pipeline_start_time = time.time()
        logger.info("🧠 Calling Claude (streaming)")

        current_tts_task = asyncio.create_task(ask_claude_streaming(question, transport))

    stt.on_transcript(on_transcript)

    await stt.start()


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
                # if is_speaking:
                #     continue
                
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
                            await stt.send(chunk)

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
                                    logger.info(f"🔧 CALLING finalize() with {len(speech_buffer)} bytes")
                                    await stt.finalize(
                                        bytes(speech_buffer)
                                    )
                                    logger.info("🔧 finalize() RETURNED")
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
        await stt.stop()
        await transport.stop()
        if Config.TTS_PROVIDER == "cartesia":
            await tts.close()  # ← close WebSocket cleanly on shutdown
        logger.info("✅ Bot shut down cleanly")