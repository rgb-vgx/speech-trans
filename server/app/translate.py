"""English -> Vietnamese translation with NLLB-200 (local, GPU).

Technical terms listed in ``glossary.json`` are protected with sentinel tokens
before translation and restored afterwards, so they stay recognisable for the
learner (typically kept in English).
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from .text_utils import tidy_vietnamese

logger = logging.getLogger(__name__)

SRC_LANG = "eng_Latn"
TGT_LANG = "vie_Latn"


@dataclass(slots=True)
class MTResult:
    text: str
    elapsed_s: float


class Glossary:
    """Case-insensitive phrase replacement with sentinel protection."""

    _MARKER_RE = re.compile(r"X\s*Q\s*Z\s*(\d+)", re.IGNORECASE)

    def __init__(self, entries: dict[str, str] | None = None) -> None:
        self._entries: list[tuple[str, str]] = []
        for source, target in (entries or {}).items():
            source = source.strip()
            if not source:
                continue
            self._entries.append((source, (target or "").strip() or source))
        # Longest phrases first so "machine learning model" wins over "model".
        self._entries.sort(key=lambda item: len(item[0]), reverse=True)
        self._pattern = (
            re.compile("|".join(rf"\b{re.escape(src)}\b" for src, _ in self._entries), re.IGNORECASE)
            if self._entries
            else None
        )

    @classmethod
    def from_file(cls, path: Path | None) -> "Glossary":
        if path is None:
            return cls()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("cannot read glossary %s: %s", path, exc)
            return cls()
        terms = data.get("terms", data) if isinstance(data, dict) else {}
        if not isinstance(terms, dict):
            logger.warning("glossary %s must be an object of {source: target}", path)
            return cls({})
        logger.info("glossary loaded: %d terms from %s", len(terms), path)
        return cls({str(k): str(v) for k, v in terms.items()})

    def __len__(self) -> int:
        return len(self._entries)

    def protect(self, text: str) -> tuple[str, list[str]]:
        """Replace known terms by sentinels; returns (text, replacements)."""
        if not self._pattern:
            return text, []
        replacements: list[str] = []
        lookup = {src.lower(): tgt for src, tgt in self._entries}

        def _sub(match: re.Match[str]) -> str:
            replacements.append(lookup[match.group(0).lower()])
            return f" XQZ{len(replacements) - 1} "

        return self._pattern.sub(_sub, text), replacements

    def restore(self, text: str, replacements: list[str]) -> str:
        if not replacements:
            return text

        def _sub(match: re.Match[str]) -> str:
            idx = int(match.group(1))
            return replacements[idx] if idx < len(replacements) else match.group(0)

        restored = self._MARKER_RE.sub(_sub, text)
        restored = re.sub(r"[ \t]{2,}", " ", restored)
        restored = re.sub(r"\s+([,.;:!?…)\]])", r"\1", restored)
        return restored.strip()


class NLLBTranslator:
    def __init__(
        self,
        model_name: str = "facebook/nllb-200-distilled-1.3B",
        *,
        device: str = "cuda",
        dtype: str = "float16",
        num_beams: int = 2,
        max_input_tokens: int = 256,
        max_new_tokens: int = 256,
        glossary_path: Path | None = None,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.dtype_name = dtype
        self.num_beams = num_beams
        self.max_input_tokens = max_input_tokens
        self.max_new_tokens = max_new_tokens
        self.glossary = Glossary.from_file(glossary_path)
        self._model = None
        self._tokenizer = None
        self._torch = None
        #: serialises tokenizer + generate (NLLB's fast tokenizer mutates its
        #: post-processor per call and is not safe to share across threads)
        self._lock = threading.Lock()
        self._load_lock = threading.Lock()

    # -- lifecycle ---------------------------------------------------------
    def load(self) -> None:
        if self._model is not None:
            return
        import torch
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

        # Concurrent load() calls (preload thread + an impatient session) used to
        # load the model twice and corrupt the fast tokenizer ("Already borrowed").
        with self._load_lock:
            if self._model is not None:
                return
            started = time.perf_counter()
            self._torch = torch
            dtype = self._resolve_dtype(torch)
            device = self.device
            if device == "cuda" and not torch.cuda.is_available():
                logger.warning("CUDA requested for MT but unavailable, falling back to CPU")
                device = self.device = "cpu"
                dtype = torch.float32
            self._tokenizer = AutoTokenizer.from_pretrained(self.model_name, src_lang=SRC_LANG)
            self._model = (
                AutoModelForSeq2SeqLM.from_pretrained(self.model_name, dtype=dtype)
                .to(device)
                .eval()
            )
            logger.info(
                "MT loaded: %s (%s/%s) in %.1fs",
                self.model_name,
                device,
                dtype,
                time.perf_counter() - started,
            )

    def _resolve_dtype(self, torch):
        if self.dtype_name in ("float16", "fp16", "half") and self.device != "cpu":
            return torch.float16
        if self.dtype_name in ("bfloat16", "bf16") and self.device != "cpu":
            return torch.bfloat16
        return torch.float32

    def warmup(self) -> None:
        # Two calls: the first generate() pays for cuDNN autotuning (several seconds).
        for _ in range(2):
            self.translate("Today we will build a small web service with Python and test the API.")

    # -- translation -------------------------------------------------------
    def translate(self, text: str) -> MTResult:
        started = time.perf_counter()
        translated = self.translate_many([text])
        return MTResult(text=translated[0], elapsed_s=time.perf_counter() - started)

    def translate_many(self, texts: list[str]) -> list[str]:
        """Blocking. Batch of independent utterances, order preserved."""
        if self._model is None:
            self.load()
        assert self._tokenizer is not None and self._model is not None and self._torch is not None

        protected: list[str] = []
        replacements: list[list[str]] = []
        for text in texts:
            src, repl = self.glossary.protect(text)
            protected.append(src)
            replacements.append(repl)

        # The tokenizer mutates internal state per call (src_lang post-processor),
        # so tokenisation, batching and generation all stay under one lock.
        with self._lock:
            # Chunk over-long inputs so NLLB never truncates mid-sentence.
            chunks: list[tuple[int, str]] = []
            for idx, text in enumerate(protected):
                chunks.extend((idx, piece) for piece in self._chunk(text))

            outputs: list[str] = [""] * len(texts)
            for batch in self._batches(chunks):
                indices = [idx for idx, _ in batch]
                pieces = [piece for _, piece in batch]
                encoded = self._tokenizer(
                    pieces,
                    return_tensors="pt",
                    padding=True,
                    truncation=True,
                    max_length=self.max_input_tokens,
                ).to(self._model.device)
                forced_bos = self._tokenizer.convert_tokens_to_ids(TGT_LANG)
                with self._torch.inference_mode():
                    generated = self._model.generate(
                        **encoded,
                        forced_bos_token_id=forced_bos,
                        num_beams=self.num_beams,
                        max_new_tokens=self.max_new_tokens,
                        length_penalty=1.0,
                    )
                decoded = self._tokenizer.batch_decode(generated, skip_special_tokens=True)
                for idx, piece in zip(indices, decoded, strict=True):
                    outputs[idx] = f"{outputs[idx]} {piece.strip()}".strip()

        result = []
        for text, repl in zip(outputs, replacements, strict=True):
            result.append(tidy_vietnamese(self.glossary.restore(text, repl)))
        return result

    def _chunk(self, text: str) -> list[str]:
        assert self._tokenizer is not None
        ids = self._tokenizer(text, add_special_tokens=False)["input_ids"]
        if len(ids) <= self.max_input_tokens:
            return [text]
        from .text_utils import split_sentences

        sentences = split_sentences(text, max_chars=400)
        chunks: list[str] = []
        current = ""
        for sentence in sentences:
            candidate = f"{current} {sentence}".strip()
            if current and len(self._tokenizer(candidate, add_special_tokens=False)["input_ids"]) > self.max_input_tokens:
                chunks.append(current)
                current = sentence
            else:
                current = candidate
        if current:
            chunks.append(current)
        return chunks or [text]

    def _batches(self, chunks: list[tuple[int, str]]):
        # Small batch size: keeps latency predictable on a 12 GB card.
        size = 4
        for start in range(0, len(chunks), size):
            yield chunks[start : start + size]
