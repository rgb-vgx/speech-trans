import numpy as np
import pytest

from app.vad import WINDOW, VADSegmenter


def make_segmenter(voiced_windows: int, **kwargs) -> VADSegmenter:
    """Silero stand-in: the first ``voiced_windows`` 512-sample windows are speech."""
    counter = {"n": 0}

    def prob(window: np.ndarray) -> float:
        assert window.size == WINDOW
        idx = counter["n"]
        counter["n"] += 1
        return 0.9 if idx < voiced_windows else 0.05

    return VADSegmenter(prob_fn=prob, threshold=0.5, **kwargs)


def test_segment_closes_after_silence():
    vad = make_segmenter(voiced_windows=30, min_speech_ms=250, min_silence_ms=350, speech_pad_ms=100)
    audio = np.ones(16_000, dtype=np.float32)  # 1s
    segments = vad.process(audio)
    assert segments == []

    segments = vad.process(np.zeros(16_000, dtype=np.float32))  # 1s silence
    assert len(segments) == 1
    segment = segments[0]
    assert 0.9 <= segment.duration_s <= 1.4
    assert segment.start_s == pytest.approx(0.0, abs=0.1)


def test_short_blip_is_dropped():
    vad = make_segmenter(voiced_windows=3, min_speech_ms=250, min_silence_ms=200)
    vad.process(np.ones(160, dtype=np.float32))  # < 1 window
    assert vad.process(np.zeros(16_000, dtype=np.float32)) == []


def test_max_segment_forces_a_cut():
    vad = make_segmenter(voiced_windows=40, min_speech_ms=100, min_silence_ms=200, max_segment_s=1.0)
    segments = vad.process(np.ones(20_480, dtype=np.float32))  # 1.28s continuous speech
    assert len(segments) == 1
    assert segments[0].duration_s <= 1.05

    segments = vad.process(np.zeros(16_000, dtype=np.float32))
    assert len(segments) == 1
    assert segments[0].start_s >= 1.0


def test_flush_returns_open_segment():
    vad = make_segmenter(voiced_windows=100, min_speech_ms=250)
    assert vad.process(np.ones(8_000, dtype=np.float32)) == []
    flushed = vad.flush()
    assert len(flushed) == 1
    assert flushed[0].duration_s > 0.4


def test_frames_arrive_in_any_size():
    vad = make_segmenter(voiced_windows=20, min_speech_ms=250, min_silence_ms=300)
    rng = np.random.default_rng(0)
    out = []
    for _ in range(20):  # 100 chunks of random size, 100 ms each
        out.extend(vad.process(np.ones(1600, dtype=np.float32)))
    out.extend(vad.process(np.zeros(20_000, dtype=np.float32)))
    assert len(out) == 1
    assert rng is not None
