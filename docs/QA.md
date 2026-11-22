# Kiểm thử

## Đã tự động hoá (chạy lại bất cứ lúc nào)

```bash
cd server
uv run pytest -q                                        # 27 unit test
uv run python scripts/e2e_wav.py ../assets/sample_en.wav --out /tmp/vi.wav
```

`e2e_wav.py` chạy đúng pipeline thật (Silero VAD → faster-whisper large-v3 →
NLLB-1.3B → VieNeu TTS) trên một file WAV tiếng Anh. Kết quả tham chiếu:

```
[1] 5.35s audio | ASR 4095 ms | MT 9740 ms   ← lần đầu (warm-up), đã xử lý bằng warmup()
     EN: Mr. Quilter is the apostle of the middle classes, ...
     VI: Ông Quilter là sứ đồ của tầng lớp trung lưu, ...
[2] 4.33s audio | ASR  378 ms | MT  226 ms
     TTS first 116 ms
```

Kiểm thử giao thức server (không cần trình duyệt):

```bash
uv run python -m app.main &          # server
uv run python scripts/ws_client.py ../assets/sample_en.wav --tts --realtime
```

Kỳ vọng: `asr`, `translation` với `total_ms` ~600–1200 ms, audio 48 kHz ghi ra file.

Native bridge (không cần Chrome): gửi framing native-messaging thủ công vào
`server/scripts/native_host.sh`; kỳ vọng trả `{"type":"info",...}` và các event
`asr`/`translation` khi stream PCM.

## Đã kiểm tra thủ công trong Chrome headless (Playwright Chromium 152, Xvfb)

- Extension load không lỗi manifest, service worker đăng ký, ID cố định
  `aolmedionghaakdlplcmabekkpbaiedc` (nhờ `key`).
- Popup render đúng; gọi background → `sendNativeMessage` → bridge → nhận
  `health` + 25 giọng; hiển thị “Server sẵn sàng · x GB VRAM trống”.
- AudioWorklet resampler phát ra frame 3200 byte (100 ms @ 16 kHz) từ oscillator.
- Native port nhận 11.9 s PCM 16 kHz (base64), chuyển qua bridge → server → trả về
  4 event `asr`/`translation` và các message audio TTS.

**Chưa tự động hoá được:** luồng `tabCapture` thật và overlay trên Udemy — Chrome
yêu cầu extension phải được người dùng “invoke” trên tab (activeTab), không thể
giả lập từ CDP. Danh sách dưới đây để bạn chạy tay một lần trên Chrome thật.

## Checklist thủ công trên Udemy

Chuẩn bị: server đang chạy (`uv run python -m app.main`), đã cài native host,
Chrome đã khởi động lại, extension đã Load unpacked.

1. **Popup**: icon hiện badge trống; mở popup thấy “Server sẵn sàng”.
2. **Bắt đầu**: mở bài giảng → bấm *Bắt đầu* → badge chuyển `ON`; tiếng bài giảng
   vẫn nghe được (không bị mute) — đây là kiểm tra quan trọng nhất của re-route.
3. **Phụ đề**: sau ~1–2 s, dòng EN hiện trước, rồi dòng VI thay thế. Chữ to, không bị
   CSS Udemy đè.
4. **Fullscreen**: bật fullscreen của player → phụ đề vẫn hiển thị (trừ khi Chrome
   fullscreen trực tiếp thẻ `<video>`).
5. **TTS**: bật *Đọc bản dịch* → nghe tiếng Việt; audio gốc giảm theo mức đã chọn;
   hết câu thì âm lượng gốc trở lại.
6. **Nghe lại**: bấm ↺ (hoặc `Alt+Shift+R`) → đọc lại đúng câu vừa dịch.
7. **Đổi giọng**: chọn giọng khác → câu tiếp theo đổi giọng.
8. **Dừng**: bấm *Dừng* → badge tắt, tiếng gốc trở lại bình thường, phụ đề tự ẩn.
9. **Server tắt giữa chừng**: `Ctrl+C` server → overlay báo đỏ; bật lại server →
   bridge tự nối lại trong ~2 s và pipeline chạy tiếp không cần reload.
10. **Pause video**: không có tiếng nói → không sinh ASR/MT rác.
10b. **Bảng câu & độ trễ**: popup → Mở → mỗi câu có EN/VI, ASR/MT/TTS ms, end-to-end;
    Copy TSV dán được; header hiện trung bình. Kiểm tra `logs/transcripts/*.jsonl`
    có bản ghi tương ứng.
11. **Chuyển tab**: capture gắn với tab đã chọn; quay lại tab đó vẫn chạy.
12. **Reload tab Udemy**: overlay phải được inject lại; nếu đang capture, dừng và
    bấm Bắt đầu lại (stream id gắn với tài liệu cũ).

Ghi lại thời gian `total_ms` hiển thị ở overlay để so với bảng trong README.
