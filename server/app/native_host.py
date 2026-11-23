"""Chrome native-messaging bridge (HTTP proxy).

Chrome blocks extension pages from talking to loopback HTTP servers (Local
Network Access), so the extension cannot call ``http://127.0.0.1:8787``
directly. This process is spawned by Chrome via
``chrome.runtime.sendNativeMessage`` and forwards requests to the local
translation server.

Native messages are JSON with a 4-byte little-endian length prefix. Install with
``python scripts/install_native_host.py``.
"""

from __future__ import annotations

import json
import logging
import os
import struct
import sys
import urllib.error
import urllib.request
from pathlib import Path

HOST_NAME = "com.speechtrans.bridge"
HTTP_BASE = os.environ.get("ST_HTTP_BASE", "http://127.0.0.1:8787")
MAX_OUT_BYTES = 900_000  # Chrome caps host->extension messages at 1 MB

_REPO_ROOT = Path(__file__).resolve().parents[2]
_LOG_DIR = Path(os.environ.get("ST_LOG_DIR", _REPO_ROOT / "logs"))
logger = logging.getLogger("speech_trans.native_host")


def _setup_logging() -> None:
    _LOG_DIR.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(_LOG_DIR / "native-host.log", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s"))
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)


def read_message(stream) -> dict | None:
    raw = stream.read(4)
    if not raw or len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    if length == 0 or length > 64 * 1024 * 1024:
        logger.warning("bad message length %d", length)
        return None
    payload = stream.read(length)
    if payload is None or len(payload) < length:
        return None
    try:
        return json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError:
        logger.warning("non-JSON message dropped")
        return None


class Bridge:
    def __init__(self) -> None:
        self._out = sys.stdout.buffer

    def send(self, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if len(data) > MAX_OUT_BYTES:
            logger.warning("dropping oversized message (%d bytes)", len(data))
            return
        self._out.write(struct.pack("<I", len(data)))
        self._out.write(data)
        self._out.flush()

    def handle(self, message: dict) -> None:
        kind = message.get("type")
        logger.info("request: %s", kind)
        if kind == "info":
            self._answer_info()
        elif kind == "http":
            self._answer_http(message)
        else:
            self.send({"type": "error", "error": f"unknown message type: {kind}"})

    def _answer_info(self) -> None:
        """Server status for the popup."""
        try:
            health = _http_json("/health")
        except Exception as exc:  # noqa: BLE001 - reported to the popup
            logger.warning("health failed: %s", exc)
            self.send({"type": "info", "error": str(exc)})
            return
        self.send({"type": "info", "health": health})

    def _answer_http(self, message: dict) -> None:
        method = str(message.get("method") or "GET").upper()
        path = str(message.get("path") or "/")
        body = message.get("body")
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(f"{HTTP_BASE}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=float(message.get("timeout") or 180)) as response:
                payload = json.loads(response.read().decode("utf-8"))
            self.send({"type": "http", "status": 200, "body": payload})
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")[:800]
            logger.warning("http %s %s -> %s %s", method, path, exc.code, detail[:200])
            self.send({"type": "http", "status": exc.code, "body": {"detail": detail}})
        except Exception as exc:  # noqa: BLE001
            logger.warning("http %s %s failed: %s", method, path, exc)
            self.send({"type": "http", "status": 0, "error": str(exc)})

    def run(self) -> None:
        while True:
            message = read_message(sys.stdin.buffer)
            if message is None:
                return
            self.handle(message)


def _http_json(path: str, timeout: float = 3.0) -> dict:
    with urllib.request.urlopen(f"{HTTP_BASE}{path}", timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    _setup_logging()
    logger.info("native host started (pid %d)", os.getpid())
    try:
        Bridge().run()
    except Exception:  # noqa: BLE001
        logger.exception("bridge crashed")
        raise
    finally:
        logger.info("native host stopped")


if __name__ == "__main__":
    main()
