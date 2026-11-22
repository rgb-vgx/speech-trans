import numpy as np
import pytest

from app.protocol import CLIENT_AUDIO, ProtocolError, decode_client_audio, pcm_f32_to_i16, pcm_i16_to_f32


def test_client_audio_roundtrip():
    samples = np.array([0.0, 0.25, -0.25, 1.0, -1.0], dtype=np.float32)
    frame = bytes([CLIENT_AUDIO]) + pcm_f32_to_i16(samples)
    decoded = decode_client_audio(frame)
    assert decoded.shape == samples.shape
    assert np.allclose(decoded, samples, atol=1e-4)


def test_client_audio_rejects_wrong_type():
    with pytest.raises(ProtocolError):
        decode_client_audio(b"\x09\x00\x00")


def test_client_audio_rejects_odd_length():
    with pytest.raises(ProtocolError):
        decode_client_audio(bytes([CLIENT_AUDIO, 0x00, 0x01, 0x02]))


def test_pcm_clipping():
    pcm = pcm_f32_to_i16(np.array([2.0, -2.0], dtype=np.float32))
    back = pcm_i16_to_f32(pcm)
    assert back[0] == pytest.approx(32767 / 32768, abs=1e-4)
    assert back[1] == pytest.approx(-1.0, abs=1e-4)
