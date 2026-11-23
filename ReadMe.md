# SpeechTrans — phụ đề Việt cho bài giảng Udemy

Extension Chrome thu âm thanh tab Udemy, gửi về server chạy local trên GPU để
**phiên âm (ASR) → dịch Anh→Việt (NLLB)**, rồi hiển thị **phụ đề song ngữ EN/VI
trên video**. Không có TTS: chỉ phụ đề.

Có hai chế độ:

| Chế độ | Nguồn | Độ trễ | Ghi chú |
|---|---|---|---|
| **Live** | Thu âm tab → VAD → ASR → dịch | ~0.6–1.8 s sau khi hết câu | Dùng được mọi video |
| **Transcript** | Caption VTT của Udemy → dịch cả bài một lần (LLM) | 0 (hiển thị theo `video.currentTime`) | Chính xác hơn; có cache |

Mặc định server chạy **transcript-only**: không nạp model, không dùng GPU, khởi động
~4 giây, VRAM 0 GB. Live mode là tuỳ chọn — bật `ST_LIVE_ENABLED=true` (và
`ST_PRELOAD=true` nếu muốn nạp sẵn model), khi đó server mới dùng GPU.

## Đo thực tế trên máy này (RTX 3060 12 GB)

Phiên live thật trên Udemy (71 câu):

| Thành phần | p50 | p95 |
|---|---|---|
| ASR (faster-whisper large-v3) | 366 ms | 658 ms |
| Dịch (NLLB-200-1.3B) | 224 ms | 1127 ms |
| **Hết câu → có bản dịch** | **654 ms** | **1764 ms** |

Cộng thêm VAD chờ 350 ms khoảng lặng để chốt câu. VRAM cho ASR + MT: ~5.5 GB.

## Kiến trúc

```
Udemy tab ──tabCapture──► offscreen doc ──16 kHz PCM/100 ms──► native bridge
   ▲                                                              │ (WebSocket)
   │  phụ đề EN/VI ◄── content script ◄── background ◄────────────┘
                                     ▲
                    VAD ─► ASR ─► NLLB (GPU, local)
```

- `server/` — FastAPI + WebSocket, Python 3.13, GPU.
- `server/app/native_host.py` — bridge cho `chrome.runtime.connectNative`
  (Chrome 138+ chặn extension mở socket tới localhost).
- `extension/` — Chrome MV3, ES modules, không cần build.

Phụ đề được **neo vào đáy thẻ `<video>`** (cách mép dưới ~60–100 px để không đè
thanh điều khiển), cập nhật khi scroll/resize/fullscreen.

## Cài đặt

### 1. Server

```bash
cd server
cp .env.example .env          # tuỳ chọn
uv sync
uv run python -m app.main
```

Chế độ mặc định (transcript-only) không tải model và khởi động trong vài giây.
Nếu bật live mode, lần chạy đầu tải model (~8 GB: NLLB 5.3 GB, Whisper large-v3
3 GB) và warm-up mất khoảng 2–4 phút. Kiểm tra: `curl -s http://localhost:8787/health`.

### 2. Native messaging bridge

```bash
cd server && uv run python scripts/install_native_host.py
```

Ghi `~/.config/{google-chrome,chromium,...}/NativeMessagingHosts/com.speechtrans.bridge.json`
và wrapper `server/scripts/native_host.sh`. **Khởi động lại Chrome** sau khi cài.

### 3. Extension

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → `extension/`.
2. Extension ID cố định: `aolmedionghaakdlplcmabekkpbaiedc` (nhờ `key` trong manifest).
3. Mở bài giảng Udemy

## Sử dụng

### Live (phụ đề realtime — tuỳ chọn)

Bật `ST_LIVE_ENABLED=true` trong `server/.env` rồi khởi động lại server.

1. Mở bài giảng → icon SpeechTrans → **Bắt đầu**.
2. Phụ đề EN (nhỏ) + VI (lớn) hiện ở đáy video.
3. Dừng bằng nút **Dừng**.

### Transcript (chính xác hơn)

1. Mở **panel Transcript** của Udemy (icon tài liệu cạnh volume trong player).
2. Extension tự đo mốc thời gian → dịch cả bài → hiện phụ đề theo video.
   Lần đầu mất ~1 phút; các lần sau lấy từ cache.
3. Panel transcript của Udemy **không có timestamp trong DOM**, nên extension
   click từng cue để video seek và đọc `video.currentTime` (video tua nhanh một
   lần rồi trở về vị trí cũ). Có thể bấm **Nạp** trong popup để chủ động chạy.

## Bảng câu & độ trễ

Popup → **Bảng câu & độ trễ → Mở**: bảng EN/VI + ASR/dịch/tổng ms, trung bình,
**Copy TSV**. Số đo cũng ghi vào `logs/transcripts/YYYY-MM-DD.jsonl`.

## Test & benchmark

```bash
cd server
uv run pytest -q                                   # 23 unit test
uv run python scripts/e2e_wav.py ../assets/sample_en.wav   # VAD→ASR→MT offline
uv run python scripts/ws_client.py ../assets/sample_en.wav --realtime
uv run python scripts/bench.py pipeline --sessions 1 --seconds 60
uv run python scripts/analyze_session.py --since "2026-11-23 00:26:20"
```

Benchmark ghi JSON vào `benchmarks/<timestamp>/`; `analyze_session.py` tạo
`benchmarks/real-<date>/REPORT.md` từ log phiên thật.

## Log runtime

| File | Nội dung |
|---|---|
| `logs/server-YYYY-MM-DD.log` | server + uvicorn (startup, ASR/MT từng câu, lỗi) |
| `logs/native-host.log` | bridge: tốc độ/RMS từng 500 frame, event server→extension |
| `logs/transcripts/YYYY-MM-DD.jsonl` | từng câu: EN, VI, asr_ms, mt_ms, total_ms |
| `logs/client.log` | chẩn đoán phía extension (probe trang, lỗi) |

Đổi thư mục bằng `ST_LOG_DIR`.

## Cấu hình (`server/.env`, xem `.env.example`)

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `ST_ASR_MODEL` | `large-v3` | `small` nếu thiếu VRAM |
| `ST_MT_MODEL` | `facebook/nllb-200-distilled-1.3B` | `600M` để nhẹ hơn |
| `ST_VAD_MIN_SILENCE_MS` | `350` | giảm để phản hồi nhanh hơn |
| `ST_GLOSSARY_FILE` | `glossary.json` | thuật ngữ giữ nguyên tiếng Anh |
| `ST_LLM_API_KEY` | — | API dịch cả bài cho chế độ transcript |
| `ST_LLM_MODEL` | `deepseek-v4.1-flash` | |
| `ST_PRELOAD` | `false` | `true` để nạp sẵn model lúc khởi động (live mode) |
| `ST_LIVE_ENABLED` | `false` | `true` để bật thu âm realtime (cần GPU) |
| `ST_LLM_FALLBACK` | `false` | `true` để fallback sang NLLB local khi LLM rate-limit |

## Sự cố thường gặp

| Hiện tượng | Xử lý |
|---|---|
| Popup báo “Bridge chưa cài” | Chạy `install_native_host.py` rồi khởi động lại Chrome |
| Popup báo “Server chưa chạy” | Chạy `uv run python -m app.main` |
| “Đang nạp model…” mãi | Bình thường 1–4 phút đầu; xem `logs/server-*.log` |
| Bấm Bắt đầu → lỗi tab | Mở đúng trang bài giảng, reload tab rồi bấm lại |
| Phụ đề không hiện | Xem trạng thái trên video/popup; live mode cần video đang phát tiếng |
| Transcript báo không thấy cue | Mở panel Transcript rồi thử lại |
| Chỉ chạy một server | Hai instance cùng nạp model gây `CUDA out of memory`; server mới từ chối chạy nếu port đã dùng |

## Hạn chế đã biết

- Live mode trễ ~0.6–1.8 s do phải chờ hết câu.
- Transcript mode phụ thuộc panel Transcript của Udemy; bước đo thời gian có thể
  tua video một lần cho mỗi bài (đã cache).
- Fullscreen trực tiếp trên thẻ `<video>` thì overlay không hiển thị (giới hạn
  của Chrome); fullscreen của Udemy (container) thì OK.
- Live mode dịch từng câu nên đại từ/ngữ cảnh xa có thể lệch; glossary giúp giữ
  thuật ngữ. Chế độ transcript dịch cả bài nên nhất quán hơn.
