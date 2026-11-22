"""Per-connection pipeline: VAD -> ASR -> MT (subtitles only).

Each stage runs as its own task and hands results to the next queue, so the
translation of utterance *n* keeps flowing while utterance *n+1* is still being
recognised. Order is preserved because every stage processes one item at a time.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from . import transcript
from .asr import WhisperASR
from .config import Settings
from .llm import LLMTranslator
from .translate import NLLBTranslator
from .vad import Segment, VADSegmenter

logger = logging.getLogger(__name__)

SendJson = Callable[[dict], Awaitable[None]]


@dataclass(slots=True)
class Utterance:
    utt_id: int
    segment: Segment
    closed_at: float
    en: str = ""
    asr_ms: int = 0


@dataclass
class PipelineServices:
    """Models shared by every session (loaded once)."""

    settings: Settings
    asr: WhisperASR
    mt: NLLBTranslator
    llm: LLMTranslator | None = None
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    loading: bool = False
    load_error: str | None = None

    def load_blocking(self) -> None:
        """Load and warm every model. Blocking: call from a worker thread."""
        if self.loading:
            return
        self.loading = True
        try:
            self.asr.warmup()
            self.mt.warmup()
        finally:
            self.loading = False


class Session:
    MAX_PENDING_SEGMENTS = 6

    def __init__(
        self,
        services: PipelineServices,
        send_json: SendJson,
        *,
        vad: VADSegmenter | None = None,
    ) -> None:
        self.services = services
        self._send_json = send_json

        s = services.settings
        self.vad = vad or VADSegmenter(
            sample_rate=s.input_sample_rate,
            threshold=s.vad_threshold,
            min_speech_ms=s.vad_min_speech_ms,
            min_silence_ms=s.vad_min_silence_ms,
            speech_pad_ms=s.vad_speech_pad_ms,
            max_segment_s=s.vad_max_segment_s,
        )

        self.session_id = uuid.uuid4().hex[:8]
        self._next_utt_id = 1
        self._queue: asyncio.Queue[Utterance] = asyncio.Queue()
        self._mt_queue: asyncio.Queue[tuple[Utterance, str]] = asyncio.Queue()
        self._tasks: list[asyncio.Task] = []
        self._closed = False

    # -- lifecycle ---------------------------------------------------------
    async def start(self) -> None:
        self._tasks = [
            asyncio.create_task(self._asr_worker(), name="asr-worker"),
            asyncio.create_task(self._mt_worker(), name="mt-worker"),
        ]
        await self._send_json(
            {
                "type": "config",
                "input_sample_rate": self.services.settings.input_sample_rate,
            }
        )

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for segment in self.vad.flush():
            await self._enqueue(segment)
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # -- input -------------------------------------------------------------
    async def feed_audio(self, samples) -> None:
        if self._closed:
            return
        for segment in self.vad.process(samples):
            await self._enqueue(segment)

    async def _enqueue(self, segment: Segment) -> None:
        if segment.duration_s < 0.15:
            logger.debug("dropping %.2fs segment (too short)", segment.duration_s)
            return
        utt_id = self._next_utt_id
        if self._queue.qsize() >= self.MAX_PENDING_SEGMENTS:
            dropped = self._queue.get_nowait()
            logger.warning("pipeline backlog full, dropping utterance %d", dropped.utt_id)
            self._queue.task_done()
        await self._queue.put(Utterance(utt_id, segment, time.monotonic()))
        logger.info(
            "utterance %d closed: %.2fs audio (%.1f-%.1fs)", utt_id, segment.duration_s, segment.start_s, segment.end_s
        )
        await self._send_json(
            {"type": "speech", "state": "end", "id": utt_id, "duration": round(segment.duration_s, 2)}
        )
        self._next_utt_id += 1

    # -- workers -----------------------------------------------------------
    async def _asr_worker(self) -> None:
        while True:
            utt = await self._queue.get()
            try:
                await self._process_asr(utt)
            finally:
                self._queue.task_done()

    async def _process_asr(self, utt: Utterance) -> None:
        started = time.perf_counter()
        try:
            result = await asyncio.to_thread(
                self.services.asr.transcribe, utt.segment.audio, self.services.settings.input_sample_rate
            )
        except Exception as exc:  # noqa: BLE001 - keep the session alive
            logger.exception("ASR failed")
            await self._send_json({"type": "error", "stage": "asr", "message": str(exc)})
            return
        if not result.text.strip():
            logger.info("utterance %d: ASR returned empty text, skipping", utt.utt_id)
            return
        asr_ms = round((time.perf_counter() - started) * 1000)
        utt.en = result.text
        utt.asr_ms = asr_ms
        logger.info("utterance %d: ASR %d ms -> %r", utt.utt_id, asr_ms, result.text[:160])
        await self._send_json(
            {
                "type": "asr",
                "id": utt.utt_id,
                "text": result.text,
                "duration": round(result.duration_s, 2),
                "elapsed_ms": asr_ms,
            }
        )
        await self._mt_queue.put((utt, result.text))

    async def _mt_worker(self) -> None:
        while True:
            utt, text = await self._mt_queue.get()
            try:
                await self._process_mt(utt, text)
            finally:
                self._mt_queue.task_done()

    async def _process_mt(self, utt: Utterance, text: str) -> None:
        started = time.perf_counter()
        try:
            result = await asyncio.to_thread(self.services.mt.translate, text)
        except Exception as exc:  # noqa: BLE001
            logger.exception("MT failed")
            await self._send_json({"type": "error", "stage": "mt", "message": str(exc)})
            return
        if not result.text.strip():
            logger.info("utterance %d: MT returned empty text, skipping", utt.utt_id)
            return
        total_ms = round((time.monotonic() - utt.closed_at) * 1000)
        mt_ms = round((time.perf_counter() - started) * 1000)
        logger.info(
            "utterance %d: MT %d ms (total %d ms) -> %r",
            utt.utt_id,
            mt_ms,
            total_ms,
            result.text[:160],
        )
        transcript.write(
            {
                "type": "utterance",
                "session": self.session_id,
                "id": utt.utt_id,
                "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "duration": round(utt.segment.duration_s, 2),
                "asr_ms": utt.asr_ms,
                "mt_ms": mt_ms,
                "total_ms": total_ms,
                "en": utt.en,
                "vi": result.text,
            }
        )
        await self._send_json(
            {
                "type": "translation",
                "id": utt.utt_id,
                "text": result.text,
                "elapsed_ms": mt_ms,
                "total_ms": total_ms,
            }
        )
