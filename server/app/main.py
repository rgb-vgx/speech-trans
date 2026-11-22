"""FastAPI entry point: WebSocket pipeline + small HTTP API for the extension."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import transcript
from .asr import WhisperASR
from .llm import LLMTranslator
from .config import get_settings
from .pipeline import PipelineServices, Session
from .protocol import ProtocolError, decode_client_audio
from .translate import NLLBTranslator

logger = logging.getLogger("speech_trans")
_STARTED_AT = time.time()
_REPO_ROOT = Path(__file__).resolve().parents[2]
_LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"


def log_dir() -> Path:
    """Runtime logs live in ``<repo>/logs`` unless ST_LOG_DIR overrides it."""
    return Path(os.environ.get("ST_LOG_DIR", _REPO_ROOT / "logs"))


def setup_logging(level: str = "INFO") -> Path | None:
    """Console + one file per day in ``logs/server-YYYY-MM-DD.log``.

    Idempotent: uvicorn's own loggers propagate here because ``run()`` passes
    ``log_config=None``, so startup, access and app logs all land in the file.
    """
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format=_LOG_FORMAT,
        force=False,
    )
    try:
        directory = log_dir()
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"server-{time.strftime('%Y-%m-%d')}.log"
        root = logging.getLogger()
        if not any(getattr(handler, "_speech_trans", False) for handler in root.handlers):
            handler = logging.FileHandler(path, encoding="utf-8")
            handler._speech_trans = True  # type: ignore[attr-defined]
            handler.setFormatter(logging.Formatter(_LOG_FORMAT))
            root.addHandler(handler)
        return path
    except OSError as exc:  # read-only checkout etc.
        logger.warning("cannot open log file: %s", exc)
        return None


class LocalNetworkCORS:
    """CORS + Private/Local Network Access for extension -> localhost requests.

    Chrome sends an ``OPTIONS`` preflight carrying
    ``Access-Control-Request-Private-Network: true`` when an extension page talks
    to a loopback server; without an explicit
    ``Access-Control-Allow-Private-Network: true`` answer the request hangs.
    Starlette's stock CORSMiddleware treats that header as unknown and replies
    400, so this middleware handles it directly.
    """

    ALLOWED_METHODS = "GET, POST, OPTIONS"

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        origin = headers.get("origin")
        requested = headers.get("access-control-request-method")
        if scope.get("path") in ("/health", "/voices"):
            logger.debug(
                "http %s %s origin=%r acrpn=%r", scope["method"], scope.get("path"), origin,
                headers.get("access-control-request-private-network"),
            )

        if not origin:
            await self.app(scope, receive, send)
            return

        base = [
            (b"access-control-allow-origin", origin.encode()),
            (b"vary", b"Origin"),
        ]
        if scope["method"] == "OPTIONS" and requested:
            allow = base + [
                (b"access-control-allow-methods", self.ALLOWED_METHODS.encode()),
                (b"access-control-allow-headers", headers.get("access-control-request-headers", "*").encode()),
                (b"access-control-allow-private-network", b"true"),
                (b"access-control-max-age", b"600"),
            ]
            await send({"type": "http.response.start", "status": 204, "headers": allow})
            await send({"type": "http.response.body", "body": b""})
            return

        async def send_with_cors(message: Message) -> None:
            if message["type"] == "http.response.start":
                message = {**message, "headers": list(message.get("headers", [])) + base}
            await send(message)

        await self.app(scope, receive, send_with_cors)


def _build_services() -> PipelineServices:
    s = get_settings()
    return PipelineServices(
        settings=s,
        asr=WhisperASR(
            s.asr_model,
            device=s.asr_device,
            compute_type=s.asr_compute_type,
            language=s.asr_language,
            beam_size=s.asr_beam_size,
            initial_prompt=s.asr_initial_prompt,
            cpu_threads=s.asr_cpu_threads,
        ),
        mt=NLLBTranslator(
            s.mt_model,
            device=s.mt_device,
            dtype=s.mt_dtype,
            num_beams=s.mt_num_beams,
            max_input_tokens=s.mt_max_input_tokens,
            max_new_tokens=s.mt_max_new_tokens,
            glossary_path=s.glossary_path,
        ),
        llm=LLMTranslator(
            base_url=s.llm_base_url,
            api_key=s.llm_api_key,
            model=s.llm_model,
            session=s.llm_session,
            timeout=s.llm_timeout,
            batch_size=s.llm_batch,
            glossary=_glossary_hint(s),
        ),
    )


def _glossary_hint(settings) -> str:
    """Terms that should stay recognisable, passed to the LLM prompt."""
    path = settings.glossary_path
    if path is None:
        return ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    terms = data.get("terms", data) if isinstance(data, dict) else {}
    if not isinstance(terms, dict):
        return ""
    return ", ".join(list(terms)[:40])


async def _preload(services: PipelineServices) -> None:
    logger.info("loading models…")
    try:
        await asyncio.to_thread(services.load_blocking)
        logger.info("models ready")
    except Exception as exc:  # noqa: BLE001 - surfaced by /health
        services.load_error = f"{type(exc).__name__}: {exc}"
        logger.exception("model preload failed")
    finally:
        services.ready.set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    path = setup_logging(get_settings().log_level)
    logger.info("=== speech-trans server starting (pid=%d) ===", os.getpid())
    if path is not None:
        logger.info("logging to %s", path)
    services = _build_services()
    app.state.services = services
    task: asyncio.Task | None = None
    if get_settings().preload:
        task = asyncio.create_task(_preload(services), name="model-preload")
    else:
        services.ready.set()
    yield
    if task is not None:
        task.cancel()


app = FastAPI(title="speech-trans", version="0.1.0", lifespan=lifespan)
# Local-only server; the extension calls /health and /voices from its popup.
app.add_middleware(LocalNetworkCORS)


def _gpu_info() -> dict:
    try:
        import torch

        if not torch.cuda.is_available():
            return {"cuda": False}
        free, total = torch.cuda.mem_get_info()
        return {
            "cuda": True,
            "device": torch.cuda.get_device_name(0),
            "vram_free_mb": round(free / 2**20),
            "vram_total_mb": round(total / 2**20),
        }
    except Exception:  # noqa: BLE001
        return {"cuda": False}


class CuesRequest(BaseModel):
    cues: list[str]
    lesson: str | None = None


class ClientLogRequest(BaseModel):
    event: dict


@app.post("/client-log")
async def client_log(req: ClientLogRequest) -> dict:
    transcript.write_debug(req.event)
    return {"ok": True}


@app.post("/translate-cues")
async def translate_cues(req: CuesRequest) -> dict:
    """Translate subtitle cues in one batch (transcript mode)."""
    services: PipelineServices = app.state.services
    llm = services.llm
    if llm is None or not llm.enabled:
        raise HTTPException(status_code=503, detail="LLM endpoint not configured")
    if not req.cues:
        return {"translations": []}
    try:
        translations = await asyncio.to_thread(llm.translate, req.cues)
    except Exception as exc:  # noqa: BLE001 - reported to the extension
        logger.exception("translate-cues failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    logger.info("translated %d cues for %r", len(translations), (req.lesson or "")[:80])
    return {"translations": translations}


@app.get("/health")
async def health() -> dict:
    services: PipelineServices = app.state.services
    if services.load_error:
        status = "error"
    elif services.ready.is_set():
        status = "ok"
    else:
        status = "loading"
    return {
        "status": status,
        "load_error": services.load_error,
        "uptime_s": round(time.time() - _STARTED_AT, 1),
        "models": {
            "asr": services.settings.asr_model,
            "mt": services.settings.mt_model,
        },
        "llm_translate": bool(services.llm and services.llm.enabled),
        "gpu": _gpu_info(),
    }


class WsConnection:
    """Serialises concurrent sends (workers + request loop share the socket)."""

    def __init__(self, websocket: WebSocket) -> None:
        self._ws = websocket
        self._lock = asyncio.Lock()

    async def send_json(self, payload: dict) -> None:
        async with self._lock:
            await self._ws.send_text(json.dumps(payload, ensure_ascii=False))


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    services: PipelineServices = websocket.app.state.services
    conn = WsConnection(websocket)
    session = Session(services, conn.send_json)
    logger.info(
        "client connected (%s, origin=%r, ua=%r)",
        websocket.client,
        websocket.headers.get("origin"),
        (websocket.headers.get("user-agent") or "")[:60],
    )
    if not services.ready.is_set():
        await conn.send_json({"type": "status", "state": "loading", "detail": "models are loading"})
    await session.start()

    frames = 0
    dropped_loading = 0
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            payload = message.get("bytes")
            if payload is not None:
                if not services.ready.is_set():
                    # Audio that arrives while models are still loading cannot be
                    # processed: accepting it would build a multi-minute backlog
                    # and (before the load locks) race the preloader.
                    dropped_loading += 1
                    if dropped_loading == 1:
                        logger.info("audio arrived before models were ready; dropping frames")
                    continue
                try:
                    samples = decode_client_audio(payload)
                except ProtocolError as exc:
                    logger.warning("bad audio frame: %s", exc)
                    continue
                frames += 1
                if frames == 1:
                    logger.info("first audio frame received (%d samples)", samples.size)
                elif frames % 500 == 0:
                    logger.info("audio frames received: %d (%.0fs)", frames, frames * 0.1)
                try:
                    await session.feed_audio(samples)
                except Exception as exc:  # noqa: BLE001
                    logger.exception("VAD failed")
                    await conn.send_json({"type": "error", "stage": "vad", "message": str(exc)})
                continue

            text = message.get("text")
            if text is None:
                continue
            try:
                control = json.loads(text)
            except json.JSONDecodeError:
                logger.warning("ignoring non-JSON control message")
                continue
            kind = control.get("type")
            if kind == "ping":
                await conn.send_json({"type": "pong", "t": control.get("t")})
            elif kind == "stats":
                await conn.send_json(
                    {
                        "type": "stats",
                        "asr_queue": session._queue.qsize(),  # noqa: SLF001 - diagnostics
                        "mt_queue": session._mt_queue.qsize(),  # noqa: SLF001
                    }
                )
            else:
                logger.debug("unknown control message: %s", kind)
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()
        logger.info(
            "client disconnected after %d audio frames (%d dropped while loading)",
            frames,
            dropped_loading,
        )


def _port_in_use(host: str, port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex((host, port)) == 0


def run() -> None:
    import sys

    import uvicorn

    settings = get_settings()
    # log_config=None: uvicorn loggers propagate to the root handler configured
    # in setup_logging(), so startup/access logs also reach logs/server-*.log.
    setup_logging(settings.log_level)
    if _port_in_use(settings.host, settings.port):
        logger.error(
            "port %s:%d is already in use — another speech-trans server is running. "
            "Stop it first (pkill -9 -f '[a]pp.main'), otherwise both load 6+ GB of "
            "models and the GPU runs out of memory.",
            settings.host,
            settings.port,
        )
        sys.exit(1)
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        log_config=None,
        ws_ping_interval=20,
        ws_ping_timeout=20,
    )


if __name__ == "__main__":
    run()
