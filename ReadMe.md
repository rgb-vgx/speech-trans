# SpeechTrans — phụ đề Việt cho bài giảng Udemy

Extension Chrome đọc **transcript/caption của bài giảng Udemy**, gửi về server local
để **dịch Anh→Việt bằng LLM API**, rồi hiển thị **phụ đề song ngữ EN/VI trên video**.

Không GPU, không model local, không thu âm tab: server chỉ là FastAPI nhỏ gọi
endpoint Anthropic-compatible (`/v1/messages`). Phụ đề hiển thị theo `video.currentTime`
nên đồng bộ chính xác với bài giảng; bản dịch được cache theo từng bài.

## Kiến trúc

```
Udemy tab ──caption VTT / textTracks / panel Transcript──► content script
                                                              │
                     phụ đề EN/VI ◄── overlay (shadow DOM) ◄──┤
                                                              ▼
                                        background ──native messaging──► bridge
                                                                           │ HTTP
                                                                           ▼
                                                    server (FastAPI) ──► LLM API
```

- `server/` — FastAPI, Python 3.12+, chỉ 3 dependency (không torch).
- `server/app/native_host.py` — bridge cho `chrome.runtime.sendNativeMessage`
  (Chrome 138+ chặn extension gọi localhost trực tiếp).
- `extension/` — Chrome MV3, ES modules, không cần build.

## Cài đặt

### 1. Server

```bash
cd server
cp .env.example .env          # điền ST_LLM_API_KEY
uv sync
uv run python -m app.main
curl -s http://localhost:8787/health
```

PowerShell (Windows):

```powershell
cd server
Copy-Item .env.example .env   # điền ST_LLM_API_KEY
uv sync
uv run python -m app.main
```

`/health` trả `{"status":"ok","mode":"transcript","llm_translate":true,...}`.
Không cần chờ nạp model — server sẵn sàng sau ~1 giây.

### 2. Native messaging bridge (Chrome/Edge)

```bash
cd server && uv run python scripts/install_native_host.py
```

- Linux/macOS: ghi `~/.config/{google-chrome,chromium,...}/NativeMessagingHosts/com.speechtrans.bridge.json`
  và wrapper `server/scripts/native_host.sh`.
- Windows: ghi `server/scripts/native_host.bat` + `com.speechtrans.bridge.json` và
  đăng ký `HKCU\Software\{Google\Chrome,Chrome Beta,Chromium,Microsoft\Edge}\NativeMessagingHosts\com.speechtrans.bridge`.
- Gỡ: thêm `--uninstall`. **Khởi động lại trình duyệt** sau khi cài.
- **Firefox không cần bước này** (xem dưới).

### 3. Extension

Chrome/Edge: `chrome://extensions` / `edge://extensions` → **Developer mode** → **Load unpacked** → `extension/`.
Extension ID cố định: `aolmedionghaakdlplcmabekkpbaiedc` (nhờ `key` trong manifest).

Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → chọn
`extension/manifest.json`. Sau đó vào `about:addons` → SpeechTrans → **Permissions**,
bật quyền cho `127.0.0.1` nếu Firefox chưa cấp (MV3 coi host permission là opt-in).
Temporary add-on biến mất khi khởi động lại Firefox — load lại, hoặc ký gói
(unlisted trên addons.mozilla.org) nếu muốn cài cố định. Firefox cho phép extension
gọi localhost trực tiếp nên không cần bridge.

Mở bài giảng Udemy sau khi cài.

## Sử dụng

1. Mở bài giảng. Extension tự tìm caption theo thứ tự: `video.textTracks` → VTT trong
   network resources / lecture API → DOM panel Transcript → (nếu cần) click từng cue để
   đo thời gian. Mở panel **Transcript** của Udemy nếu extension báo chưa thấy cue.
2. Lần đầu mỗi bài: dịch cả bài qua LLM (~1 phút với bài 100–200 câu). Các lần sau lấy
   từ cache (`chrome.storage.local`, khoá theo URL bài giảng).
3. Phụ đề EN (nhỏ) + VI (lớn) neo ở đáy video. Popup cho **Nạp** lại, **Tắt** phụ đề,
   bật/tắt hiển thị, canh thời gian và xem nhật ký debug.
4. Nếu phụ đề lệch so với tiếng (một số bài có intro/offset riêng), chỉnh ô **Canh thời
   gian** trong popup: số dương = hiện sớm hơn, số âm = hiện trễ hơn, bước 0,25 s; giá trị
   được lưu lại và áp dụng ngay.
5. Muốn dời phụ đề lên/xuống, kéo thanh **Vị trí phụ đề** (2–50% chiều cao video, tính từ
   đáy); thay đổi áp dụng ngay và được lưu lại.
6. Bật **Ẩn phụ đề gốc** để tắt phụ đề tiếng Anh của Udemy, chỉ còn EN/VI của SpeechTrans.
   Extension ẩn bằng CSS (`video::cue` + container caption) nên vẫn đọc được caption để
   dịch. Muốn chỉ hiện tiếng Việt thì bật thêm **Ẩn dòng EN**.

## Cấu hình (`server/.env`, xem `.env.example`)

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `ST_HOST` / `ST_PORT` | `127.0.0.1` / `8787` | chỉ mở loopback |
| `ST_LLM_BASE_URL` | `https://opencode.ai/inference/go/anthropic/v1/messages` | endpoint Anthropic-compatible |
| `ST_LLM_API_KEY` | — | **bắt buộc** để dịch |
| `ST_LLM_MODEL` | `deepseek-v4.1-flash` | |
| `ST_LLM_SESSION` | `speech-trans` | header `x-opencode-session` |
| `ST_LLM_BATCH` | `20` | số cue mỗi request; giảm nếu bị rate-limit |
| `ST_LLM_TIMEOUT` | `180` | giây |
| `ST_GLOSSARY_FILE` | `glossary.json` | thuật ngữ giữ nguyên tiếng Anh |

## Test

```bash
cd server
uv run pytest -q
```

## Log runtime

| File | Nội dung |
|---|---|
| `logs/server-YYYY-MM-DD.log` | server + uvicorn (startup, từng batch dịch, lỗi) |
| `logs/native-host.log` | bridge: request `info`/`http` |
| `logs/client.log` | chẩn đoán phía extension (probe trang, cache, lỗi) |

Đổi thư mục bằng `ST_LOG_DIR`.

## Sự cố thường gặp

| Hiện tượng | Xử lý |
|---|---|
| Popup báo “Bridge chưa cài” (Chrome/Edge) | Chạy `install_native_host.py` rồi khởi động lại trình duyệt |
| Firefox báo “chưa cấp quyền 127.0.0.1” | `about:addons` → SpeechTrans → Permissions → bật quyền cho `127.0.0.1` |
| Popup báo “Server chưa chạy” | Chạy `uv run python -m app.main` |
| Firefox mất extension sau khi restart | Temporary add-on chỉ sống trong phiên; load lại ở `about:debugging` hoặc ký gói để cài cố định |
| Popup báo “Server thiếu ST_LLM_API_KEY” | Điền key vào `server/.env` rồi restart server |
| Transcript báo không thấy cue | Mở panel Transcript của Udemy rồi bấm **Nạp** |
| Dịch lỗi 429/rate-limit | Giảm `ST_LLM_BATCH` (ví dụ 10); extension tự chia batch và thử lại |
| Phụ đề không hiện | Kiểm tra toggle **Phụ đề** trong popup và trạng thái trên video |

## Hạn chế đã biết

- Phụ thuộc transcript/caption của Udemy; bước đo thời gian có thể tua video một lần
  cho mỗi bài (kết quả đã cache).
- Không có phụ đề realtime: phải dịch xong cả bài (hoặc lấy cache) trước khi xem.
- Fullscreen trực tiếp trên thẻ `<video>` thì overlay không hiển thị (giới hạn của Chrome);
  fullscreen của Udemy (container) thì OK.
- Chất lượng phụ thuộc LLM; glossary giúp giữ thuật ngữ, nhưng đại từ/ngữ cảnh xa có thể lệch.
