"""Append-only JSONL transcript of every utterance (for offline review).

One file per day under ``~/.cache/speech-trans/transcripts/``:

    {"type":"utterance","session":"ab12cd34","id":3,"at":"2026-11-22T23:10:02",
     "duration":4.33,"asr_ms":414,"mt_ms":239,"total_ms":653,
     "en":"...","vi":"..."}
    {"type":"tts","session":"ab12cd34","id":3,"tts_ms":2392,"chunks":52}
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_LOCK = threading.Lock()


def _base_dir() -> Path:
    import os

    return Path(os.environ.get("ST_LOG_DIR", _REPO_ROOT / "logs")) / "transcripts"




def directory() -> Path:
    return _base_dir()


def write_debug(record: dict) -> None:
    """Generic client-side debug sink (logs/client.log) for diagnostics."""
    try:
        directory_path = _base_dir().parent
        directory_path.mkdir(parents=True, exist_ok=True)
        path = directory_path / "client.log"
        line = json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), **record}, ensure_ascii=False)
        with _LOCK, path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def write_debug(record: dict) -> None:
    """Generic client-side debug sink (logs/client.log) for diagnostics."""
    try:
        directory_path = _base_dir().parent
        directory_path.mkdir(parents=True, exist_ok=True)
        path = directory_path / "client.log"
        line = json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), **record}, ensure_ascii=False)
        with _LOCK, path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def write_client(record: dict) -> None:
    """Playback timeline reported by the extension (every 5 s while TTS runs)."""
    try:
        directory_path = _base_dir()
        directory_path.mkdir(parents=True, exist_ok=True)
        path = directory_path / f"client-stats-{time.strftime('%Y-%m-%d')}.jsonl"
        line = json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), **record}, ensure_ascii=False)
        with _LOCK, path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def write(record: dict) -> None:
    """Blocking but tiny; called from the pipeline workers."""
    try:
        directory_path = _base_dir()
        directory_path.mkdir(parents=True, exist_ok=True)
        path = directory_path / f"{time.strftime('%Y-%m-%d')}.jsonl"
        line = json.dumps(record, ensure_ascii=False)
        with _LOCK, path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:  # never let logging break the pipeline
        pass
