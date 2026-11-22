import numpy as np

from app.text_utils import split_sentences, tidy_vietnamese
from app.translate import Glossary


def test_split_sentences_basic():
    text = "First sentence. Second one! Third?  And a fourth."
    assert split_sentences(text) == ["First sentence.", "Second one!", "Third?", "And a fourth."]


def test_split_sentences_respects_abbreviations():
    parts = split_sentences("Use e.g. this API. Then continue.")
    assert parts == ["Use e.g. this API.", "Then continue."]


def test_split_long_sentence():
    text = "a, " * 120
    parts = split_sentences(text.strip(), max_chars=100)
    assert all(len(p) <= 100 for p in parts)


def test_tidy_vietnamese():
    assert tidy_vietnamese("  xin chào ,  bạn . ") == "Xin chào, bạn."


def test_glossary_protect_restore():
    glossary = Glossary({"WebSocket": "", "gradient descent": "hạ gradient"})
    text, repl = glossary.protect("A WebSocket streams data during gradient descent.")
    assert "WebSocket" not in text
    assert repl == ["WebSocket", "hạ gradient"]
    restored = glossary.restore(text, repl)
    assert restored == "A WebSocket streams data during hạ gradient."


def test_glossary_case_insensitive_and_longest_first():
    glossary = Glossary({"model": "mô hình", "machine learning model": "mô hình học máy"})
    text, repl = glossary.protect("This MODEL is a machine learning model.")
    assert repl == ["mô hình", "mô hình học máy"]
    assert glossary.restore(text, repl) == "This mô hình is a mô hình học máy."


def test_glossary_handles_marker_spacing():
    glossary = Glossary({"Docker": "Docker"})
    text, repl = glossary.protect("Use Docker here")
    garbled = text.replace("XQZ0", "xqz 0")
    assert glossary.restore(garbled, repl) == "Use Docker here"


def test_glossary_empty():
    glossary = Glossary()
    assert len(glossary) == 0
    text, repl = glossary.protect("nothing to protect")
    assert text == "nothing to protect"
    assert glossary.restore(text, repl) == "nothing to protect"


def test_no_numpy_array_in_protect():
    # regression guard: protect must return str, not ndarray
    glossary = Glossary({"API": "API"})
    text, _ = glossary.protect("an API call")
    assert isinstance(text, str)
    assert isinstance(np.array([1]), np.ndarray)
