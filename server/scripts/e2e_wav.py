#!/usr/bin/env python
"""Offline smoke test: WAV (English lecture) -> VAD -> ASR -> MT -> TTS.

Run with:  uv run python scripts/e2e_wav.py assets/sample_en.wav --out /tmp/vi.wav
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.asr import WhisperASR  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.translate import NLLBTranslator  # noqa: E402
from app.vad import VADSegmenter  # noqa: E402


def read_wav_16k(path: Path) -> np.ndarray:
    import soundfile as sf

    audio, rate = sf.read(str(path), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if rate != 16_000:
        import soxr

        mono = soxr.resample(mono, rate, 16_000)
    return mono.astype(np.float32)


def write_wav(path: Path, audio: np.ndarray, rate: int) -> None:
    import soundfile as sf

    sf.write(str(path), audio, rate)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("wav", type=Path, help="English WAV file (any sample rate)")
    parser.add_argument("--out", type=Path, default=None, help="optional JSON output path")
    args = parser.parse_args()

    settings = get_settings()
    audio = read_wav_16k(args.wav)
    print(f"input: {args.wav} ({audio.size / 16_000:.1f}s)")

    t0 = time.perf_counter()
    vad = VADSegmenter(
        sample_rate=16_000,
        threshold=settings.vad_threshold,
        min_speech_ms=settings.vad_min_speech_ms,
        min_silence_ms=settings.vad_min_silence_ms,
        speech_pad_ms=settings.vad_speech_pad_ms,
        max_segment_s=settings.vad_max_segment_s,
    )
    asr = WhisperASR(
        settings.asr_model,
        device=settings.asr_device,
        compute_type=settings.asr_compute_type,
        language=settings.asr_language,
        beam_size=settings.asr_beam_size,
        initial_prompt=settings.asr_initial_prompt,
    )
    mt = NLLBTranslator(
        settings.mt_model,
        device=settings.mt_device,
        dtype=settings.mt_dtype,
        num_beams=settings.mt_num_beams,
        max_input_tokens=settings.mt_max_input_tokens,
        max_new_tokens=settings.mt_max_new_tokens,
        glossary_path=settings.glossary_path,
    )
    print(f"models loaded in {time.perf_counter() - t0:.1f}s")

    segments = vad.process(audio) + vad.flush()
    print(f"VAD found {len(segments)} segment(s)")

    rows = []
    for index, segment in enumerate(segments, start=1):
        t = time.perf_counter()
        result = asr.transcribe(segment.audio)
        asr_s = time.perf_counter() - t
        t = time.perf_counter()
        translation = mt.translate(result.text)
        mt_s = time.perf_counter() - t
        print(
            f"[{index}] {segment.duration_s:5.2f}s audio | ASR {asr_s * 1000:4.0f} ms | "
            f"MT {mt_s * 1000:4.0f} ms\n     EN: {result.text}\n     VI: {translation.text}"
        )
        rows.append(
            {
                "id": index,
                "audio_s": round(segment.duration_s, 2),
                "asr_ms": round(asr_s * 1000),
                "mt_ms": round(mt_s * 1000),
                "en": result.text,
                "vi": translation.text,
            }
        )
    if args.out is not None:
        import json

        args.out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
