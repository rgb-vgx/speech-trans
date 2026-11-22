"""Chrome native-messaging bridge.

Chrome blocks extension pages from talking to loopback HTTP/WebSocket servers
(Local Network Access), so the extension cannot open ``ws://localhost:8787``
directly. This process is spawned by Chrome via ``chrome.runtime.connectNative``
and bridges between:

    Chrome extension  <->  stdin/stdout (native messaging framing)  <->  this
                       <->  WebSocket  <->  app.main (FastAPI, GPU pipeline)

Native messages are JSON with a 4-byte little-endian length prefix. Binary audio
is base64-encoded. Install with ``python scripts/install_native_host.py``.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import queue
import struct
import sys
import threading
import time
import urllib.request
from pathlib import Path

HOST_NAME = "com.speechtrans.bridge"
WS_URL = os.environ.get("ST_BRIDGE_WS", "ws://127.0.0.1:8787/ws")
HTTP_BASE = os.environ.get("ST_HTTP_BASE", "http://127.0.0.1:8787")
RECONNECT_S = 2.0
MAX_OUT_BYTES = 900_000  # Chrome caps host->extension messages at 1 MB
_CLIENT_AUDIO = 0x01
_SERVER_AUDIO = 0x02

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
        self._write_lock = threading.Lock()
        self._queue: queue.Queue[dict | None] = queue.Queue(maxsize=512)
        self._stop = threading.Event()
        self._last_config: dict | None = None
        self._in_frames = 0
        self._out_audio = 0
        self._t_first = time.monotonic()

    # -- native side -------------------------------------------------------
    def send(self, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if len(data) > MAX_OUT_BYTES:
            logger.warning("dropping oversized message (%d bytes)", len(data))
            return
        try:
            with self._write_lock:
                self._out.write(struct.pack("<I", len(data)))
                self._out.write(data)
                self._out.flush()
        except (BrokenPipeError, OSError):
            self._stop.set()

    def emit_event(self, event: dict) -> None:
        self.send({"type": "event", "payload": event})

    # -- stdin -------------------------------------------------------------
    def _stdin_loop(self) -> None:
        while not self._stop.is_set():
            message = read_message(sys.stdin.buffer)
            if message is None:
                self._stop.set()
                self._queue.put(None)
                return
            self._handle_incoming(message)

    def _handle_incoming(self, message: dict) -> None:
        kind = message.get("type")
        if kind == "info":
            self._answer_info(message)
            return
        if kind == "http":
            # translation can take a while: do not block the audio loop
            threading.Thread(target=self._answer_http, args=(message,), daemon=True).start()
            return
        if kind == "config":
            self._last_config = {k: message[k] for k in ("tts", "voice") if k in message}
            logger.info("client config: %s", self._last_config)
        try:
            self._queue.put_nowait(message)
        except queue.Full:
            logger.warning("uplink queue full, dropping %s", kind)

    def _answer_info(self, message: dict) -> None:
        """Server status for the popup: no WebSocket needed."""
        try:
            health = _http_json("/health")
        except Exception as exc:  # noqa: BLE001 - reported to the popup
            self.send({"type": "info", "error": str(exc)})
            return
        self.send({"type": "info", "health": health})

    def _answer_http(self, message: dict) -> None:
        """Small HTTP client for the extension (it cannot reach localhost)."""
        import urllib.error

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

    # -- websocket side ----------------------------------------------------
    def _sender_loop(self, ws) -> None:
        while not self._stop.is_set():
            try:
                message = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if message is None:
                return
            try:
                self._forward(ws, message)
            except Exception as exc:  # noqa: BLE001 - connection dropped
                logger.info("send failed: %s", exc)
                return

    def _forward(self, ws, message: dict) -> None:
        kind = message.get("type")
        if kind == "audio":
            try:
                pcm = base64.b64decode(message.get("data", ""))
            except Exception as exc:  # noqa: BLE001
                logger.warning("bad base64 audio from extension: %s", exc)
                return
            if pcm:
                self._in_frames += 1
                if self._in_frames == 1:
                    self._t_first = time.monotonic()
                    logger.info(
                        "first audio frame from extension: %d bytes, rms=%.4f", len(pcm), _rms_i16(pcm)
                    )
                elif self._in_frames % 500 == 0:
                    wall = time.monotonic() - self._t_first
                    logger.info(
                        "audio frames from extension: %d (%.0fs audio, %.1fs wall, rms=%.4f)",
                        self._in_frames,
                        self._in_frames * 0.1,
                        wall,
                        _rms_i16(pcm),
                    )
                ws.send(bytes([_CLIENT_AUDIO]) + pcm)
        elif kind in ("config", "interrupt", "ping", "client-stats"):
            if kind not in ("ping",):
                logger.info("forwarding %s to server: %s", kind, json.dumps(message, ensure_ascii=False)[:200])
            ws.send(json.dumps(message))

    def _drain_queue(self) -> None:
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                return

    def run(self) -> None:
        self._setup_imports()
        # chrome.runtime.sendNativeMessage() launches a fresh host and resolves on
        # the FIRST message it sends: answer those directly and exit, so a
        # "bridge-connected" event can never race the real reply.
        first = read_message(sys.stdin.buffer)
        if first is None:
            return
        if first.get("type") in ("info", "http"):
            if first["type"] == "info":
                self._answer_info(first)
            else:
                self._answer_http(first)
            return
        self._handle_incoming(first)
        threading.Thread(target=self._stdin_loop, name="stdin", daemon=True).start()

        while not self._stop.is_set():
            try:
                from websockets.sync.client import connect

                with connect(WS_URL, max_size=None, open_timeout=3) as ws:
                    logger.info("connected to %s", WS_URL)
                    if self._last_config:
                        ws.send(json.dumps({"type": "config", **self._last_config}))
                    self.emit_event({"type": "status", "state": "bridge-connected"})
                    sender = threading.Thread(target=self._sender_loop, args=(ws,), daemon=True, name="ws-send")
                    sender.start()
                    while not self._stop.is_set():
                        raw = ws.recv()
                        if isinstance(raw, str):
                            try:
                                event = json.loads(raw)
                            except json.JSONDecodeError:
                                continue
                            if event.get("type") not in ("pong", "speech"):
                                summary = dict(event)
                                summary.pop("voices", None)
                                logger.info("server -> extension: %s", json.dumps(summary, ensure_ascii=False)[:300])
                            self.emit_event(event)
                        elif isinstance(raw, (bytes, bytearray)) and len(raw) >= 5 and raw[0] == _SERVER_AUDIO:
                            utt_id = int.from_bytes(raw[1:5], "little")
                            self._out_audio += 1
                            if self._out_audio == 1:
                                logger.info("first TTS audio chunk from server: %d bytes", len(raw) - 5)
                            self.send(
                                {
                                    "type": "audio",
                                    "id": utt_id,
                                    "data": base64.b64encode(bytes(raw[5:])).decode("ascii"),
                                }
                            )
            except Exception as exc:  # noqa: BLE001 - server not up yet / dropped
                logger.info("websocket unavailable: %s", exc)
                self.emit_event(
                    {"type": "status", "state": "disconnected", "detail": "Chưa kết nối được server GPU"}
                )
                self._drain_queue()
                time.sleep(RECONNECT_S)

    def _setup_imports(self) -> None:
        """Keep import failures out of stdout (native messaging owns stdout)."""
        try:
            import websockets  # noqa: F401
        except ImportError:
            logger.error("websockets package missing; bridge cannot run")
            raise


def _http_json(path: str, timeout: float = 3.0) -> dict:
    with urllib.request.urlopen(f"{HTTP_BASE}{path}", timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _rms_i16(pcm: bytes) -> float:
    """RMS of little-endian int16 PCM, used only for diagnostics."""
    samples = memoryview(pcm).cast("h")
    if not samples:
        return 0.0
    total = 0
    for value in samples:
        total += value * value
    return (total / len(samples)) ** 0.5 / 32768.0


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
