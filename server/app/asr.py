"""Speech recognition with faster-whisper (CTranslate2, GPU)."""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

import numpy as np

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ASRResult:
    text: str
    language: str
    duration_s: float
    elapsed_s: float


class WhisperASR:
    def __init__(
        self,
        model_name: str = "large-v3",
        *,
        device: str = "cuda",
        compute_type: str = "int8_float16",
        language: str = "en",
        beam_size: int = 1,
        initial_prompt: str = "",
        cpu_threads: int = 4,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self.beam_size = beam_size
        self.initial_prompt = initial_prompt or None
        self.cpu_threads = cpu_threads
        self._model = None
        self._load_lock = threading.Lock()

    def load(self) -> None:
        if self._model is not None:
            return
        with self._load_lock:
            if self._model is not None:
                return
            from faster_whisper import WhisperModel

            started = time.perf_counter()
            self._model = WhisperModel(
                self.model_name,
                device=self.device,
                compute_type=self.compute_type,
                cpu_threads=self.cpu_threads,
            )
            logger.info(
                "ASR loaded: %s (%s/%s) in %.1fs",
                self.model_name,
                self.device,
                self.compute_type,
                time.perf_counter() - started,
            )

    def warmup(self) -> None:
        """Run the real decode path twice: the first call triggers cuDNN autotune
        and costs seconds, which must not land on the user's first sentence."""
        self.load()
        rng = np.random.default_rng(0)
        probe = (rng.standard_normal(16_000 * 4) * 0.02).astype(np.float32)
        for _ in range(2):
            self.transcribe(probe)

    def transcribe(self, audio: np.ndarray, sample_rate: int = 16_000) -> ASRResult:
        """Blocking. Run from a worker thread."""
        if self._model is None:
            self.load()
        if sample_rate != 16_000:
            raise ValueError(f"expected 16 kHz audio, got {sample_rate}")

        started = time.perf_counter()
        segments, info = self._model.transcribe(  # type: ignore[union-attr]
            audio,
            language=self.language,
            beam_size=self.beam_size,
            best_of=1,
            temperature=0.0,
            vad_filter=False,  # segmentation already happened upstream
            condition_on_previous_text=False,  # avoids runaway repeat loops
            initial_prompt=self.initial_prompt,
            without_timestamps=True,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        elapsed = time.perf_counter() - started
        logger.info("ASR %.2fs audio -> %.2fs (%.1fx) %r", audio.size / 16_000, elapsed, audio.size / 16_000 / max(elapsed, 1e-9), text[:120])
        return ASRResult(
            text=text,
            language=getattr(info, "language", self.language),
            duration_s=audio.size / 16_000,
            elapsed_s=elapsed,
        )
