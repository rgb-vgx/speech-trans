#!/usr/bin/env python
"""Protocol-level smoke test: stream a WAV to the running server over WebSocket.

    uv run python -m app.main                      # terminal 1
    uv run python scripts/ws_client.py ../assets/sample_en.wav

This mimics what the browser extension does (16 kHz int16 frames, 100 ms each)
and prints every server event, so it also validates the wire protocol.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

import numpy as np

FRAME_SAMPLES = 1600  # 100 ms @ 16 kHz


def load_wav_16k(path: Path) -> np.ndarray:
    import soundfile as sf

    audio, rate = sf.read(str(path), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if rate != 16_000:
        import soxr

        mono = soxr.resample(mono, rate, 16_000)
    return mono.astype(np.float32)


def to_i16(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("wav", type=Path)
    parser.add_argument("--url", default="ws://127.0.0.1:8787/ws")
    parser.add_argument("--realtime", action="store_true", help="pace frames at 100 ms like a live tab")
    parser.add_argument("--idle-timeout", type=float, default=5.0)
    args = parser.parse_args()

    import websockets

    audio = load_wav_16k(args.wav)
    last_message = time.monotonic()

    async with websockets.connect(args.url, max_size=None) as ws:

        async def receiver() -> None:
            nonlocal last_message
            async for message in ws:
                last_message = time.monotonic()
                if isinstance(message, bytes):
                    continue
                event = json.loads(message)
                event.pop("voices", None)
                print("<-", json.dumps(event, ensure_ascii=False))

        task = asyncio.create_task(receiver())
        started = time.perf_counter()
        for start in range(0, audio.size, FRAME_SAMPLES):
            frame = audio[start : start + FRAME_SAMPLES]
            if frame.size == 0:
                break
            await ws.send(b"\x01" + to_i16(frame))
            if args.realtime:
                await asyncio.sleep(FRAME_SAMPLES / 16_000)
        print(f"sent {audio.size / 16_000:.1f}s of audio in {time.perf_counter() - started:.1f}s")

        while time.monotonic() - last_message < args.idle_timeout:
            await asyncio.sleep(0.2)
        task.cancel()
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
