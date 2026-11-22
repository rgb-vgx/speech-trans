"""Streaming voice-activity segmentation on top of Silero VAD.

The segmenter turns a continuous 16 kHz mono stream into utterances: it waits
for ``min_silence_ms`` of silence before closing a segment (so natural pauses
inside a sentence do not split it) and force-closes a segment after
``max_segment_s`` so a fast talker never blocks the pipeline for long.
"""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass
from typing import Callable

import numpy as np

logger = logging.getLogger(__name__)

WINDOW = 512  # Silero VAD window @ 16 kHz


@dataclass(slots=True)
class Segment:
    """A closed utterance, ready for ASR."""

    audio: np.ndarray  # float32 mono @ sample_rate
    start_s: float
    end_s: float

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s


def _load_silero(onnx: bool = True) -> Callable[[np.ndarray], float]:
    from silero_vad import load_silero_vad  # imported lazily: heavy deps

    import torch

    model = load_silero_vad(onnx=onnx)

    def prob(window: np.ndarray) -> float:
        tensor = torch.from_numpy(np.ascontiguousarray(window, dtype=np.float32))
        with torch.inference_mode():
            return float(model(tensor, 16_000).item())

    return prob


class VADSegmenter:
    """Incremental VAD → utterance segmentation.

    ``prob_fn`` can be injected for tests; by default it uses Silero VAD.
    """

    def __init__(
        self,
        *,
        sample_rate: int = 16_000,
        threshold: float = 0.5,
        min_speech_ms: int = 250,
        min_silence_ms: int = 350,
        speech_pad_ms: int = 200,
        max_segment_s: float = 12.0,
        prob_fn: Callable[[np.ndarray], float] | None = None,
    ) -> None:
        self.sample_rate = sample_rate
        self.threshold = threshold
        self.min_speech_samples = int(sample_rate * min_speech_ms / 1000)
        self.min_silence_samples = int(sample_rate * min_silence_ms / 1000)
        self.pad_samples = int(sample_rate * speech_pad_ms / 1000)
        self.max_segment_samples = int(sample_rate * max_segment_s)

        self._prob = prob_fn or _load_silero()

        self._leftover = np.zeros(0, dtype=np.float32)
        self._history: deque[np.ndarray] = deque()
        self._history_len = 0
        self._history_cap = self.pad_samples + WINDOW

        self._in_speech = False
        self._seg_parts: list[np.ndarray] = []
        self._seg_len = 0
        self._voiced_samples = 0
        self._trailing_silence = 0
        self._seg_start = 0
        self._clock = 0  # absolute samples consumed

    # -- public API --------------------------------------------------------
    def process(self, audio: np.ndarray) -> list[Segment]:
        """Feed mono float32 samples, return utterances that closed."""
        if audio.size == 0:
            return []
        buf = np.concatenate((self._leftover, audio.astype(np.float32, copy=False)))
        n_windows = buf.size // WINDOW
        out: list[Segment] = []
        for i in range(n_windows):
            window = buf[i * WINDOW : (i + 1) * WINDOW]
            out.extend(self._process_window(window))
        self._leftover = buf[n_windows * WINDOW :].copy()
        return out

    def flush(self) -> list[Segment]:
        """Close the utterance in progress (call when the stream stops)."""
        self._leftover = np.zeros(0, dtype=np.float32)
        if not self._in_speech:
            return []
        return self._close(trim_trailing=True)

    # -- internals ---------------------------------------------------------
    def _process_window(self, window: np.ndarray) -> list[Segment]:
        start_clock = self._clock
        self._clock += WINDOW
        is_voiced = self._prob(window) >= self.threshold
        out: list[Segment] = []

        if not self._in_speech:
            self._remember(window)
            if is_voiced:
                self._in_speech = True
                self._seg_parts = [self._history_block()]
                self._seg_len = sum(part.size for part in self._seg_parts)
                self._voiced_samples = WINDOW
                self._trailing_silence = 0
                # history already contains the current window
                self._seg_start = max(0, start_clock - (self._history_len - WINDOW))
                self._history.clear()
                self._history_len = 0
            return out

        self._seg_parts.append(window)
        self._seg_len += WINDOW
        if is_voiced:
            self._voiced_samples += WINDOW
            self._trailing_silence = 0
        else:
            self._trailing_silence += WINDOW

        if self._seg_len >= self.max_segment_samples:
            out.extend(self._close(trim_trailing=True))
            # Keep talking: start the next chunk immediately to avoid gaps.
            self._in_speech = True
            self._seg_parts = []
            self._seg_len = 0
            self._voiced_samples = 0
            self._trailing_silence = 0
            self._seg_start = self._clock
        elif self._trailing_silence >= self.min_silence_samples:
            out.extend(self._close(trim_trailing=True))
        return out

    def _remember(self, window: np.ndarray) -> None:
        self._history.append(window)
        self._history_len += window.size
        while self._history and self._history_len > self._history_cap:
            self._history_len -= self._history.popleft().size

    def _history_block(self) -> np.ndarray:
        if not self._history:
            return np.zeros(0, dtype=np.float32)
        block = np.concatenate(tuple(self._history))
        return block[-self._history_cap :]

    def _close(self, *, trim_trailing: bool) -> list[Segment]:
        audio = np.concatenate(self._seg_parts) if self._seg_parts else np.zeros(0, np.float32)
        voiced = self._voiced_samples
        trailing = self._trailing_silence
        start_s = self._seg_start / self.sample_rate
        self._in_speech = False
        self._seg_parts = []
        self._seg_len = 0
        self._voiced_samples = 0
        self._trailing_silence = 0
        self._history.clear()
        self._history_len = 0

        if voiced < self.min_speech_samples:
            logger.debug("dropping %.2fs voiced segment (below min_speech)", voiced / self.sample_rate)
            return []

        if trim_trailing:
            # Keep a short tail so ASR does not clip the last consonant.
            keep = min(audio.size, max(0, audio.size - trailing + self.pad_samples))
            audio = audio[:keep]
        if audio.size == 0:
            return []
        return [Segment(audio=audio, start_s=start_s, end_s=start_s + audio.size / self.sample_rate)]
