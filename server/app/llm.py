"""Batch subtitle translation through an Anthropic-compatible LLM endpoint.

Used by transcript mode: the whole lecture transcript is translated once (with
context across cues), cached by the extension, then displayed synced to the
video. The endpoint and key come from the environment, never from code.
"""

from __future__ import annotations

import json
import logging
import re
import time
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

_SYSTEM = (
    "You translate English video lecture subtitles into natural Vietnamese. "
    "Keep the speaker's meaning, tone and technical terms; keep widely used "
    "English technical terms in English (e.g. API, Docker, PyTorch, loss function) "
    "when that is how Vietnamese learners say them. Never merge or split lines. "
    "Output only a JSON array of strings, one per input line, with no markdown."
)


class LLMTranslator:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        session: str = "speech-trans",
        timeout: float = 180.0,
        batch_size: int = 20,
        glossary: str = "",
    ) -> None:
        self.base_url = base_url
        self.api_key = api_key
        self.model = model
        self.session = session
        self.timeout = timeout
        self.batch_size = max(1, batch_size)
        self.glossary = glossary.strip()

    @property
    def enabled(self) -> bool:
        return bool(self.api_key and self.base_url)

    # -- public ------------------------------------------------------------
    def translate(self, texts: list[str]) -> list[str]:
        """Translate a list of subtitle lines, preserving order and length."""
        if not self.enabled:
            raise RuntimeError("LLM endpoint is not configured (ST_LLM_API_KEY)")
        cleaned = [text.strip() for text in texts]
        out: list[str] = []
        for start in range(0, len(cleaned), self.batch_size):
            batch = cleaned[start : start + self.batch_size]
            out.extend(self._translate_batch(batch, start))
        return out

    # -- internals ---------------------------------------------------------
    def _translate_batch(self, batch: list[str], offset: int) -> list[str]:
        started = time.perf_counter()
        try:
            result = self._request(self._prompt(batch))
        except RuntimeError as exc:
            if len(batch) > 1:
                # A long batch can run out of tokens or hit a transient error;
                # split and retry before giving up on individual lines.
                middle = len(batch) // 2
                logger.warning(
                    "LLM batch @%d failed (%s), splitting %d -> %d+%d",
                    offset,
                    str(exc)[:160],
                    len(batch),
                    middle,
                    len(batch) - middle,
                )
                return self._translate_batch(batch[:middle], offset) + self._translate_batch(
                    batch[middle:], offset + middle
                )
            # Single line: keep the English text so the subtitle is never lost.
            logger.warning("LLM failed for a single line @%d, keeping source text", offset)
            return batch

        if len(result) != len(batch):
            logger.warning(
                "LLM returned %d lines for %d inputs (batch @%d); retrying individually",
                len(result),
                len(batch),
                offset,
            )
            fixed: list[str] = []
            for text in batch:
                try:
                    single = self._request(self._prompt([text]))
                    fixed.append(single[0] if single else text)
                except RuntimeError:
                    fixed.append(text)
            result = fixed

        logger.info(
            "LLM batch @%d: %d lines in %.0f ms",
            offset,
            len(batch),
            (time.perf_counter() - started) * 1000,
        )
        return result

    def _prompt(self, batch: list[str]) -> str:
        lines = "\n".join(f"{index + 1}. {text}" for index, text in enumerate(batch))
        glossary = f"\nGlossary to respect: {self.glossary}" if self.glossary else ""
        return (
            f"Translate these {len(batch)} subtitle lines into Vietnamese.{glossary}\n"
            f"Return exactly a JSON array of {len(batch)} strings.\n\n{lines}"
        )

    def _request(self, prompt: str, attempts: int = 3) -> list[str]:
        last: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                return self._request_once(prompt)
            except RuntimeError as exc:
                last = exc
                logger.warning("LLM attempt %d/%d failed: %s", attempt, attempts, str(exc)[:200])
                if attempt < attempts:
                    time.sleep(0.8 * attempt)
        raise last  # type: ignore[misc]

    def _request_once(self, prompt: str) -> list[str]:
        payload = {
            "model": self.model,
            # Reasoning tokens count against max_tokens: with 4096 a 20-line
            # batch could spend everything on thinking and return no text.
            "max_tokens": 8192,
            "thinking": {"type": "disabled"},
            "system": _SYSTEM,
            "messages": [{"role": "user", "content": prompt}],
        }
        request = urllib.request.Request(
            self.base_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "x-opencode-session": self.session,
                # Cloudflare fronting the endpoint blocks Python's default UA
                # (error 1010); a normal client UA is required.
                "User-Agent": "speech-trans/0.1 (local)",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")[:400]
            raise RuntimeError(f"LLM HTTP {exc.code}: {detail}") from exc
        except Exception as exc:  # noqa: BLE001 - surfaced to the caller
            raise RuntimeError(f"LLM request failed: {exc}") from exc

        text = "".join(
            block.get("text", "")
            for block in body.get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        ).strip()
        return self._parse_array(text)

    @staticmethod
    def _parse_array(text: str) -> list[str]:
        fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
        candidate = fenced.group(1) if fenced else text
        match = re.search(r"\[.*\]", candidate, re.DOTALL)
        if not match:
            raise RuntimeError(f"LLM did not return a JSON array: {text[:200]}")
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"LLM returned invalid JSON: {exc}") from exc
        if not isinstance(parsed, list):
            raise RuntimeError("LLM response is not a list")
        return [str(item).strip() for item in parsed]
