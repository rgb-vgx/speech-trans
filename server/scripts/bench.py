#!/usr/bin/env python
"""Pipeline benchmark against the running server (subtitles only).

    uv run python scripts/bench.py pipeline --sessions 1 --seconds 60
    uv run python scripts/bench.py pipeline --sessions 2 --seconds 60

Streams the sample lecture at real time through N WebSocket sessions; with N
sessions ASR and MT each have N concurrent requests (the contention scenario).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
import urllib.request
from pathlib import Path

import numpy as np

HTTP = "http://127.0.0.1:8787"
WS = "ws://127.0.0.1:8787/ws"
ROOT = Path(__file__).resolve().parents[2]
WAV = ROOT / "assets" / "sample_en.wav"
BENCH_DIR = ROOT / "benchmarks"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round((p / 100) * (len(ordered) - 1))))
    return ordered[index]


def summarize(values: list[float]) -> dict:
    if not values:
        return {"n": 0, "p50": None, "p95": None, "mean": None}
    return {
        "n": len(values),
        "p50": round(percentile(values, 50), 1),
        "p95": round(percentile(values, 95), 1),
        "mean": round(statistics.fmean(values), 1),
    }


def load_wav_16k() -> np.ndarray:
    import soundfile as sf

    audio, rate = sf.read(str(WAV), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if rate != 16_000:
        import soxr

        mono = soxr.resample(mono, rate, 16_000)
    return mono.astype(np.float32)


def to_i16(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()


def post_json(path: str, payload: dict) -> dict:
    request = urllib.request.Request(
        f"{HTTP}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.loads(response.read())


# ---------------------------------------------------------------------------
# Sustained pipeline load
# ---------------------------------------------------------------------------

async def gpu_sampler(stop: asyncio.Event, samples: list[tuple[float, float]]) -> None:
    while not stop.is_set():
        try:
            proc = await asyncio.create_subprocess_exec(
                "nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used",
                "--format=csv,noheader,nounits",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await proc.communicate()
            first = out.decode().strip().splitlines()[0]
            util, memory = (part.strip() for part in first.split(",")[:2])
            samples.append((float(util), float(memory)))
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(1.0)


async def stream_session(
    audio: np.ndarray,
    seconds: float,
    result: dict,
) -> None:
    import websockets

    events: list[dict] = []
    sent = 0

    async with websockets.connect(WS, max_size=None) as ws:
        async def receiver() -> None:
            async for message in ws:
                if isinstance(message, bytes):
                    continue
                event = json.loads(message)
                kind = event.get("type")
                if kind == "asr":
                    events.append({"kind": "asr", "id": event["id"], "ms": event["elapsed_ms"]})
                elif kind == "translation":
                    events.append(
                        {"kind": "mt", "id": event["id"], "ms": event["elapsed_ms"], "total": event["total_ms"]}
                    )

        task = asyncio.create_task(receiver())
        started = time.perf_counter()
        position = 0
        while time.perf_counter() - started < seconds:
            frame = audio[position : position + 1600]
            if frame.size < 1600:
                position = 0
                frame = audio[position : position + 1600]
            position += 1600
            await ws.send(b"\x01" + to_i16(frame))
            sent += 1
            await asyncio.sleep(0.1)
        await asyncio.sleep(2.0)
        task.cancel()
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass

    result.update({"events": events, "frames": sent, "wall": time.perf_counter() - started})


async def bench_pipeline(args: argparse.Namespace) -> None:
    audio = load_wav_16k()
    gpu_samples: list[tuple[float, float]] = []
    stop = asyncio.Event()
    sampler = asyncio.create_task(gpu_sampler(stop, gpu_samples))

    started = time.perf_counter()
    results: list[dict] = [{} for _ in range(args.sessions)]
    await asyncio.gather(*(stream_session(audio, args.seconds, results[i]) for i in range(args.sessions)))
    wall = time.perf_counter() - started
    stop.set()
    await sampler

    asr = [e["ms"] for r in results for e in r["events"] if e["kind"] == "asr"]
    mt = [e["ms"] for r in results for e in r["events"] if e["kind"] == "mt"]
    total = [e["total"] for r in results for e in r["events"] if e["kind"] == "mt"]
    utterances = len(asr)
    frames = sum(r["frames"] for r in results)

    print("\n=== Pipeline sustained load ===")
    print(f"sessions        : {args.sessions}")
    print(f"duration        : {wall:.1f}s   (audio sent: {frames * 0.1:.0f}s per session)")
    print(f"utterances      : {utterances}  ({utterances / wall * 60:.1f}/min)")
    print(f"ASR ms          : {summarize(asr)}")
    print(f"MT ms           : {summarize(mt)}")
    print(f"Speech->translation ms: {summarize(total)}")
    if gpu_samples:
        utils = [s[0] for s in gpu_samples]
        mems = [s[1] for s in gpu_samples]
        print(f"GPU util        : mean {statistics.fmean(utils):.0f}%  max {max(utils):.0f}%")
        print(f"VRAM peak       : {max(mems):.0f} MiB")

    write_result(
        args,
        f"pipeline-{args.sessions}session",
        {
            "summary": {
                "sessions": args.sessions,
                "wall_s": round(wall, 1),
                "utterances": utterances,
                "utterances_per_min": round(utterances / wall * 60, 1),
                "asr_ms": summarize(asr),
                "mt_ms": summarize(mt),
                "pipeline_total_ms": summarize(total),
                "gpu_util_mean": round(statistics.fmean([x[0] for x in gpu_samples]), 1) if gpu_samples else None,
                "gpu_util_max": max([x[0] for x in gpu_samples]) if gpu_samples else None,
                "vram_peak_mib": max([x[1] for x in gpu_samples]) if gpu_samples else None,
            }
        },
    )


def write_result(args: argparse.Namespace, name: str, payload: dict) -> None:
    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{name}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nresult -> {path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    pipeline = sub.add_parser("pipeline", help="sustained load through the WebSocket pipeline")
    pipeline.add_argument("--sessions", type=int, default=1, choices=[1, 2, 3])
    pipeline.add_argument("--seconds", type=float, default=60)
    pipeline.add_argument("--out-dir", default=None)

    args = parser.parse_args()
    args.out_dir = Path(args.out_dir) if args.out_dir else BENCH_DIR / time.strftime("%Y%m%d-%H%M%S")
    asyncio.run(bench_pipeline(args))


if __name__ == "__main__":
    main()
