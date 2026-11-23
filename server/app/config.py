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

    # --- HTTP server ------------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 8787
    log_level: str = "INFO"

    # --- Translation (LLM API) -------------------------------------------
    llm_base_url: str = "https://opencode.ai/inference/go/anthropic/v1/messages"
    llm_api_key: str = ""
    llm_model: str = "deepseek-v4.1-flash"
    llm_session: str = "speech-trans"
    llm_batch: int = 20
    llm_timeout: float = 180.0

    # --- glossary --------------------------------------------------------
    #: English terms the LLM should keep as-is in the Vietnamese subtitles
    glossary_file: str = str(_SERVER_DIR / "glossary.json")

    @property
    def glossary_path(self) -> Path | None:
        path = Path(self.glossary_file).expanduser()
        return path if path.is_file() else None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
