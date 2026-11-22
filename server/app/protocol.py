"""Wire protocol between the browser extension and this server.

Transport is a single WebSocket.

Client -> server
    binary frame : ``0x01`` + little-endian int16 PCM, 16 kHz mono (100 ms chunks)
    text frame   : JSON control message, e.g. ``{"type": "ping"}``

Server -> client
    text frame   : JSON event (``asr``, ``translation``, ``status``, ``error``, ``stats``)
"""

from __future__ import annotations

import numpy as np

CLIENT_AUDIO = 0x01


class ProtocolError(ValueError):
    """Raised for malformed frames."""


def decode_client_audio(data: bytes) -> np.ndarray:
    """Decode a client binary frame into float32 mono samples in [-1, 1]."""
    if not data:
        raise ProtocolError("empty frame")
    if data[0] != CLIENT_AUDIO:
        raise ProtocolError(f"unexpected client frame type {data[0]:#04x}")
    payload = data[1:]
    if len(payload) % 2:
        raise ProtocolError("odd PCM byte count")
    return pcm_i16_to_f32(payload)


def pcm_i16_to_f32(data: bytes) -> np.ndarray:
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def pcm_f32_to_i16(samples: np.ndarray) -> bytes:
    """Convert float32 samples to little-endian int16 bytes (clipped)."""
    if samples.dtype != np.float32:
        samples = samples.astype(np.float32, copy=False)
    clipped = np.clip(samples, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()
