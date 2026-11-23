"""Application settings, loaded from environment (prefix ``ST_``) or ``.env``."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_SERVER_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ST_",
        env_file=str(_SERVER_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- HTTP / WS server -------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 8787
    log_level: str = "INFO"

    # --- audio ------------------------------------------------------------
    input_sample_rate: int = 16_000
    output_sample_rate: int = 48_000
    #: hard cap for audio buffered while a model is busy (seconds)
    max_backlog_s: float = 30.0

    # --- VAD --------------------------------------------------------------
    vad_threshold: float = 0.5
    vad_min_speech_ms: int = 250
    vad_min_silence_ms: int = 350
    vad_speech_pad_ms: int = 200
    vad_max_segment_s: float = 12.0

    # --- ASR (faster-whisper) --------------------------------------------
    asr_model: str = "large-v3"
    asr_device: str = "cuda"
    asr_compute_type: str = "int8_float16"
    asr_language: str = "en"
    asr_beam_size: int = 1
    asr_initial_prompt: str = ""
    asr_cpu_threads: int = 4

    # --- MT (NLLB) --------------------------------------------------------
    mt_model: str = "facebook/nllb-200-distilled-1.3B"
    mt_device: str = "cuda"
    mt_dtype: str = "float16"
    mt_num_beams: int = 2
    mt_max_input_tokens: int = 256
    mt_max_new_tokens: int = 256
    glossary_file: str = str(_SERVER_DIR / "glossary.json")

    # --- LLM (transcript mode) -------------------------------------------
    llm_base_url: str = "https://opencode.ai/inference/go/anthropic/v1/messages"
    llm_api_key: str = ""
    llm_model: str = "deepseek-v4.1-flash"
    llm_session: str = "speech-trans"
    llm_batch: int = 20
    llm_timeout: float = 180.0
    #: falls back to the local NLLB model (GPU) when the LLM is rate-limited
    llm_fallback: bool = False

    # --- misc -------------------------------------------------------------
    #: transcript-only server: no model preload, live capture disabled
    preload: bool = False
    live_enabled: bool = False

    @property
    def glossary_path(self) -> Path | None:
        path = Path(self.glossary_file).expanduser()
        return path if path.is_file() else None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
