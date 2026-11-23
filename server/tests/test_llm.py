"""Unit tests for the cue translator and the HTTP API."""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from app import main
from app.llm import LLMTranslator


def translator(**overrides) -> LLMTranslator:
    options = {
        "base_url": "http://example.test/v1/messages",
        "api_key": "test-key",
        "model": "test-model",
    }
    options.update(overrides)
    return LLMTranslator(**options)


# -- JSON parsing ---------------------------------------------------------
def test_parse_array_plain() -> None:
    assert LLMTranslator._parse_array('["Xin chào", "Tạm biệt"]') == ["Xin chào", "Tạm biệt"]


def test_parse_array_with_code_fence() -> None:
    assert LLMTranslator._parse_array('```json\n["một"]\n```') == ["một"]


def test_parse_array_rejects_text() -> None:
    with pytest.raises(RuntimeError):
        LLMTranslator._parse_array("không có mảng json")


def test_prompt_numbers_each_line() -> None:
    prompt = translator()._prompt(["first line", "second line"])
    assert "1. first line" in prompt
    assert "2. second line" in prompt
    assert "2 strings" in prompt


# -- translation ----------------------------------------------------------
def test_translate_batches_and_keeps_order(monkeypatch) -> None:
    llm = translator(batch_size=2)
    calls: list[str] = []

    def fake_request(prompt: str, attempts: int = 3) -> list[str]:
        calls.append(prompt)
        count = int(re.search(r"these (\d+) subtitle", prompt).group(1))
        return [f"vi{index}" for index in range(count)]

    monkeypatch.setattr(llm, "_request", fake_request)
    assert llm.translate(["a", "b", "c"]) == ["vi0", "vi1", "vi0"]
    assert len(calls) == 2


def test_translate_keeps_source_when_llm_fails(monkeypatch) -> None:
    llm = translator()

    def failing_request(prompt: str, attempts: int = 3) -> list[str]:
        raise RuntimeError("LLM HTTP 500")

    monkeypatch.setattr(llm, "_request", failing_request)
    assert llm.translate(["hello world"]) == ["hello world"]


# -- HTTP API -------------------------------------------------------------
class FakeLLM:
    model = "fake-model"
    enabled = True

    def translate(self, cues: list[str]) -> list[str]:
        return [f"VI: {cue}" for cue in cues]


def test_health_reports_transcript_mode() -> None:
    with TestClient(main.app) as client:
        body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["mode"] == "transcript"
    assert "gpu" not in body


def test_translate_cues_returns_translations() -> None:
    with TestClient(main.app) as client:
        main.app.state.llm = FakeLLM()
        response = client.post(
            "/translate-cues",
            json={"lesson": "test", "cues": ["Hello", "Goodbye"]},
        )
    assert response.status_code == 200
    assert response.json()["translations"] == ["VI: Hello", "VI: Goodbye"]


def test_translate_cues_requires_api_key() -> None:
    with TestClient(main.app) as client:
        main.app.state.llm = translator(api_key="")
        response = client.post("/translate-cues", json={"cues": ["Hello"]})
    assert response.status_code == 503
