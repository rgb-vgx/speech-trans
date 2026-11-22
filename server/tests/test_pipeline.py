import asyncio
from dataclasses import dataclass

import numpy as np
import pytest

from app.asr import ASRResult
from app.config import Settings
from app.pipeline import PipelineServices, Session
from app.translate import MTResult
from app.vad import VADSegmenter


class StubASR:
    def transcribe(self, audio, sample_rate=16_000):
        return ASRResult(text="hello world", language="en", duration_s=len(audio) / 16_000, elapsed_s=0.0)


class StubMT:
    def translate(self, text):
        return MTResult(text="xin chào thế giới", elapsed_s=0.0)


@dataclass
class Collector:
    events: list

    async def send_json(self, payload):
        self.events.append(payload)



def amplitude_prob(window: np.ndarray) -> float:
    return 0.9 if float(np.abs(window).mean()) > 0.1 else 0.02


def build_session() -> tuple[Session, Collector]:
    settings = Settings()
    services = PipelineServices(settings=settings, asr=StubASR(), mt=StubMT())
    services.ready.set()
    vad = VADSegmenter(prob_fn=amplitude_prob, **{})
    collector = Collector(events=[])
    session = Session(services, collector.send_json, vad=vad)
    return session, collector


async def wait_until(predicate, timeout: float = 3.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition not met in time")


async def test_pipeline_produces_asr_and_translation():
    session, collector = build_session()
    await session.start()
    try:
        await session.feed_audio(np.ones(16_000, dtype=np.float32))
        await session.feed_audio(np.zeros(16_000, dtype=np.float32))
        await wait_until(lambda: any(event["type"] == "translation" for event in collector.events))
    finally:
        await session.close()

    assert collector.events[0]["type"] == "config"
    asr = [e for e in collector.events if e["type"] == "asr"]
    assert len(asr) == 1
    assert asr[0]["text"] == "hello world"
    translation = [e for e in collector.events if e["type"] == "translation"]
    assert translation[0]["text"] == "xin chào thế giới"
    assert translation[0]["total_ms"] >= 0


async def test_close_is_idempotent():
    session, _ = build_session()
    await session.start()
    await session.close()
    await session.close()


@pytest.mark.parametrize("chunk", [1_600, 3_200, 8_000])
async def test_arbitrary_chunk_sizes(chunk: int):
    session, collector = build_session()
    await session.start()
    try:
        voiced = np.ones(16_000, dtype=np.float32)
        for start in range(0, voiced.size, chunk):
            await session.feed_audio(voiced[start : start + chunk])
        silence = np.zeros(16_000, dtype=np.float32)
        for start in range(0, silence.size, chunk):
            await session.feed_audio(silence[start : start + chunk])
        await wait_until(lambda: any(e["type"] == "translation" for e in collector.events))
    finally:
        await session.close()
    assert sum(1 for e in collector.events if e["type"] == "translation") == 1
