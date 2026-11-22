"""Small text helpers shared by translation and TTS."""

from __future__ import annotations

import re

_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")
_ABBREVIATIONS = ("e.g.", "i.e.", "etc.", "vs.", "Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "No.")


def split_sentences(text: str, *, max_chars: int = 180) -> list[str]:
    """Split text into sentences, further breaking over-long ones at commas."""
    text = " ".join(text.split())
    if not text:
        return []

    protected = text
    for i, abbr in enumerate(_ABBREVIATIONS):
        protected = protected.replace(abbr, abbr.replace(".", f"\x00{i}\x00"))

    parts = [p.strip() for p in _SENTENCE_END.split(protected) if p.strip()]
    for i, abbr in enumerate(_ABBREVIATIONS):
        marker = abbr.replace(".", f"\x00{i}\x00")
        parts = [p.replace(marker, abbr) for p in parts]

    out: list[str] = []
    for part in parts:
        if len(part) <= max_chars:
            out.append(part)
            continue
        out.extend(_split_long(part, max_chars))
    return out


def _split_long(text: str, max_chars: int) -> list[str]:
    chunks: list[str] = []
    current = ""
    for piece in re.split(r"(?<=[,;:])\s+", text):
        candidate = f"{current} {piece}".strip() if current else piece
        if current and len(candidate) > max_chars:
            chunks.append(current)
            current = piece
        else:
            current = candidate
    if current:
        chunks.append(current)
    # Last resort: hard-wrap anything still too long.
    final: list[str] = []
    for chunk in chunks:
        while len(chunk) > max_chars:
            cut = chunk.rfind(" ", 0, max_chars)
            cut = cut if cut > 0 else max_chars
            final.append(chunk[:cut].strip())
            chunk = chunk[cut:].strip()
        if chunk:
            final.append(chunk)
    return final


def tidy_vietnamese(text: str) -> str:
    """Clean up spacing artefacts that machine translation tends to produce."""
    text = " ".join(text.split())
    text = re.sub(r"\s+([,.;:!?…)\]])", r"\1", text)
    text = re.sub(r"([(\[])\s+", r"\1", text)
    text = re.sub(r"\s+'", "'", text)
    if text and text[0].islower():
        text = text[0].upper() + text[1:]
    return text
