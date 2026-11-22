#!/usr/bin/env python
"""Turn real-session logs into a benchmark report.

Reads (default: <repo>/logs):
  server-YYYY-MM-DD.log            per-utterance ASR / MT / TTS timings
  transcripts/YYYY-MM-DD.jsonl     EN + VI per utterance
  transcripts/client-stats-*.jsonl playback backlog reported by the extension

    uv run python scripts/analyze_session.py                # today
    uv run python scripts/analyze_session.py --date 2026-11-23 --out ../benchmarks/real
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOG_DIR = ROOT / "logs"

UTT_CLOSED = re.compile(r"utterance (\d+) closed: ([\d.]+)s audio")
ASR = re.compile(r"utterance (\d+): ASR (\d+) ms -> '(.*)'")
MT = re.compile(r"utterance (\d+): MT (\d+) ms \(total (\d+) ms\) -> '(.*)'")
LINE_TS = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")


def percentiles(values: list[float]) -> dict:
    if not values:
        return {"n": 0, "p50": None, "p95": None, "mean": None}
    ordered = sorted(values)
    return {
        "n": len(ordered),
        "p50": round(ordered[round(0.5 * (len(ordered) - 1))], 1),
        "p95": round(ordered[round(0.95 * (len(ordered) - 1))], 1),
        "mean": round(statistics.fmean(ordered), 1),
    }


def parse_server_log(path: Path, since: str | None = None) -> dict:
    raw = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    data: dict[int, dict] = {}
    current_ts = None
    for line in raw:
        stamp = LINE_TS.match(line)
        if stamp:
            current_ts = stamp.group(1)
        if since and current_ts and current_ts < since:
            continue
        if match := UTT_CLOSED.search(line):
            data.setdefault(int(match.group(1)), {})["audio_s"] = float(match.group(2))
        elif match := ASR.search(line):
            row = data.setdefault(int(match.group(1)), {})
            row["asr_ms"] = int(match.group(2))
            row["en"] = match.group(3)
        elif match := MT.search(line):
            row = data.setdefault(int(match.group(1)), {})
            row["mt_ms"] = int(match.group(2))
            row["total_ms"] = int(match.group(3))
            row["vi"] = match.group(4)

    return {"utterances": data}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=time.strftime("%Y-%m-%d"))
    parser.add_argument("--since", default=None, help='e.g. "2026-11-23 00:26:20"')
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    log_dir = Path(args.out) if args.out else ROOT / "benchmarks" / f"real-{args.date}"
    log_dir.mkdir(parents=True, exist_ok=True)

    server_log = LOG_DIR / f"server-{args.date}.log"
    if not server_log.is_file():
        raise SystemExit(f"no server log at {server_log}")

    parsed = parse_server_log(server_log, args.since)
    rows = parsed["utterances"]
    with_text = {uid: row for uid, row in rows.items() if row.get("en")}

    report = {
        "date": args.date,
        "since": args.since,
        "utterances": len(rows),
        "utterances_with_text": len(with_text),
        "audio_total_s": round(sum(row.get("audio_s", 0) for row in rows.values()), 1),
        "asr_ms": percentiles([row["asr_ms"] for row in with_text.values() if "asr_ms" in row]),
        "mt_ms": percentiles([row["mt_ms"] for row in with_text.values() if "mt_ms" in row]),
        "total_ms": percentiles([row["total_ms"] for row in with_text.values() if "total_ms" in row]),
    }

    out_json = log_dir / "real-session.json"
    out_json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        f"# Phiên thật — {args.date}",
        "",
        f"- Câu: **{report['utterances']}** ({report['utterances_with_text']} có bản dịch)",
        f"- Tổng audio: **{report['audio_total_s']} s**",
        f"- ASR: p50 {report['asr_ms']['p50']} ms / p95 {report['asr_ms']['p95']} ms",
        f"- Dịch: p50 {report['mt_ms']['p50']} ms / p95 {report['mt_ms']['p95']} ms",
        f"- Tổng hết-câu→có-dịch: p50 {report['total_ms']['p50']} ms / p95 {report['total_ms']['p95']} ms",
        "",
        "## Câu mẫu",
        "",
    ]
    for utt_id in sorted(with_text)[:12]:
        row = with_text[utt_id]
        lines.append(f"- **#{utt_id}** ({row.get('audio_s')}s) — EN: {row.get('en')}")
        lines.append(f"  - VI: {row.get('vi')}")
        lines.append(
            f"  - ASR {row.get('asr_ms')} ms · dịch {row.get('mt_ms')} ms · tổng {row.get('total_ms')} ms"
        )

    out_md = log_dir / "REPORT.md"
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[:11]))
    print(f"\nreport -> {out_md}\njson   -> {out_json}")


if __name__ == "__main__":
    main()
