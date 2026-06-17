"""
Audio normalisation utility.
Measures RMS loudness of raw PCM s16le audio and applies gain
to reach a target level (default -18 dBFS). Caps gain at +12 dB
to prevent crackling on near-silence chunks.
"""

import numpy as np
from loguru import logger

def normalize_audio(pcm_bytes: bytes, target_dbfs: float = -18.0) -> bytes:
    if not pcm_bytes:
        logger.warning("🔇 Empty audio received for normalization")
        return pcm_bytes

    audio = np.frombuffer(pcm_bytes, dtype=np.int16)  # bytes -> PCM samples

    if len(audio) == 0:
        logger.warning("🔇 No PCM samples found")
        return pcm_bytes

    rms = np.sqrt(np.mean(audio.astype(np.float64) ** 2))  # calculate loudness

    if rms <= 0:
        logger.info("🔇 Silence detected, skipping normalization")
        return pcm_bytes

    current_dbfs = 20 * np.log10(rms / 32767.0)  # current volume
    gain_db = target_dbfs - current_dbfs  # gain needed
    gain = 10 ** (gain_db / 20)  # dB -> multiplier

    logger.info(
        f"🎚️ Audio Normalization | Current: {current_dbfs:.2f} dBFS | "
        f"Target: {target_dbfs:.2f} dBFS | Gain: {gain_db:+.2f} dB"
    )

    normalized = audio.astype(np.float64) * gain  # apply gain
    normalized = np.clip(normalized, -32768, 32767).astype(np.int16)  # prevent clipping

    return normalized.tobytes()