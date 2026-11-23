"""FastAPI entry point: HTTP API used by the extension (transcript translation)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import transcript
from .config import get_settings
from .llm import LLMTranslator

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
    ``log_config=None``, so startup and access logs all land in the file.
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


def _build_llm() -> LLMTranslator:
    s = get_settings()
    return LLMTranslator(
        base_url=s.llm_base_url,
        api_key=s.llm_api_key,
        model=s.llm_model,
        session=s.llm_session,
        timeout=s.llm_timeout,
        batch_size=s.llm_batch,
        glossary=_glossary_hint(s),
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    path = setup_logging(get_settings().log_level)
    logger.info("=== speech-trans server starting (pid=%d) ===", os.getpid())
    if path is not None:
        logger.info("logging to %s", path)
    app.state.llm = _build_llm()
    yield


app = FastAPI(title="speech-trans", version="0.2.0", lifespan=lifespan)
# Local-only server; the extension calls these endpoints through its bridge.
app.add_middleware(LocalNetworkCORS)


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
    llm: LLMTranslator = app.state.llm
    if not llm.enabled:
        raise HTTPException(status_code=503, detail="LLM endpoint not configured (ST_LLM_API_KEY)")
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
    llm: LLMTranslator = app.state.llm
    return {
        "status": "ok",
        "uptime_s": round(time.time() - _STARTED_AT, 1),
        "mode": "transcript",
        "llm_translate": llm.enabled,
        "model": llm.model,
    }


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
            "port %s:%d is already in use — another speech-trans server is running. Stop it first.",
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
    )


if __name__ == "__main__":
    run()
