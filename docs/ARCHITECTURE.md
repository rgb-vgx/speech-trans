# Kiến trúc SpeechTrans

Code nằm trong `server/app/` và `extension/src/`. Hệ thống chỉ có một chế độ:
**transcript** — không GPU, không model local, không thu âm tab.

## 1. Mục tiêu và ràng buộc

| Yêu cầu | Cách đáp ứng |
|---|---|
| Phụ đề Việt cho bài giảng Udemy | Lấy caption/transcript của bài, dịch cả bài, hiện theo `video.currentTime` |
| Không cần GPU | Dịch qua LLM API (Anthropic-compatible `/v1/messages`) |
| Không gửi dữ liệu lung tung | Server chỉ gọi endpoint LLM đã cấu hình; key nằm trong `server/.env` |
| Chịu được Chrome chặn localhost | Đi qua native-messaging bridge thay vì `fetch('http://127.0.0.1:8787')` |
| Xem lại không tốn tiền | Cache bản dịch theo URL bài giảng trong `chrome.storage.local` |

## 2. Luồng dữ liệu

```
Udemy tab
  video.textTracks ─┐
  VTT (network/API) ─┼─► content.js: lấy cue {start, text}
  panel Transcript  ─┤        │ chia batch 20
  click-seek (dự phòng)┘      ▼
                     chrome.runtime.sendMessage({type:"translate-cues"})
                              │
                        background.js
                              │ chrome.runtime.sendNativeMessage
                              ▼
                    native_host.py (stdio, framing 4-byte LE + JSON)
                              │ HTTP POST /translate-cues
                              ▼
                    FastAPI server ──► LLM API
                              │ {"translations":[...]}
                              ▼
                     background ─► content: cue.en / cue.vi
                              │
                     overlay shadow DOM (đáy <video>)
```

## 3. Lấy transcript

Thứ tự thử trong `content.js`:

1. `video.textTracks` (nếu trình duyệt đã nạp caption).
2. Probe network resources của player: tìm `.vtt`, hoặc gọi lecture API của Udemy
   (`/api-2.0/users/me/subscribed-courses/.../lectures/...`) để lấy URL VTT.
3. Scrape DOM panel Transcript (`[data-purpose="transcript-cue"]`, các selector dự phòng).
4. Panel có cue nhưng không có timestamp: click từng cue → video seek → đọc
   `video.currentTime`; sau đó trả video về vị trí cũ. Chỉ chạy khi người dùng đồng ý
   (hộp thoại xác nhận) và kết quả được cache.

Cache: `chrome.storage.local["tr:<origin+path>"] = {v:2, cues:[{start,end,en,vi}]}`.
Khi đọc cache, nếu >25% câu có `vi === en` (bản dịch cũ lỗi/giữ nguyên tiếng Anh) thì
coi là cache hỏng và dịch lại.

## 4. Dịch

- `content.js` chia cue thành batch `ST_LLM_BATCH` (mặc định 20) và gửi **tuần tự**
  (một batch một lúc) để tránh rate-limit; lỗi thì chờ 1.2 s và thử lại một lần.
- `server/app/llm.py`:
  - system prompt: dịch phụ đề bài giảng sang tiếng Việt tự nhiên, giữ thuật ngữ
    tiếng Anh thông dụng, **không gộp/tách dòng**, chỉ trả JSON array.
  - `thinking: disabled` để token không bị tiêu vào phần suy luận; `max_tokens=8192`.
  - mỗi request thử tối đa 3 lần (backoff 0.8 s, 1.6 s).
  - nếu một batch lỗi: chia đôi và thử lại; nếu một dòng vẫn lỗi: giữ nguyên câu tiếng Anh
    (không làm mất phụ đề).
  - glossary (`glossary.json`) được chèn vào prompt dưới dạng danh sách thuật ngữ.
- Endpoint: `POST /translate-cues {cues, lesson}` → `{translations}` (giữ đúng thứ tự và
  số dòng). `/health` trả trạng thái + model; `/client-log` nhận log chẩn đoán từ extension.

## 5. Hiển thị

- Overlay nằm trong shadow root (`#speech-trans-root`) để CSS Udemy không ảnh hưởng.
- Neo vào đáy thẻ `<video>` (cách mép dưới ~56–120 px), cập nhật mỗi 500 ms và khi
  scroll/resize/fullscreen.
- `syncTranscript()` chạy mỗi 250 ms: binary search cue theo `video.currentTime`, hiện
  dòng EN (nhỏ) + VI (lớn); cue đang active luôn hiện, không tự ẩn. `cue.end` của VTT
  được tôn trọng: hết cue (khoảng lặng) thì ẩn thay vì giữ câu cũ.
- Popup có ô **Canh thời gian** (`cueOffset`, −15…+15 s, bước 0,25 s): dương = hiện sớm
  hơn; lưu trong `storage.local` và gửi xuống content script qua message `ui-config`.
- Popup cũng có thanh **Vị trí phụ đề** (`captionBottom`, 2–50% chiều cao video tính từ
  đáy): `positionOverlay()` dùng giá trị này thay cho khoảng cách cố định, nên kéo lên/xuống
  áp dụng ngay cả trong fullscreen.
- **Ẩn phụ đề gốc** (`hideNative`): chèn `<style>` vào trang với `video::cue { visibility:
  hidden }` và `display:none` cho các container caption quen thuộc (`.vjs-text-track-display`,
  `.shaka-text-container`, `[class*="captions-container"]`…). Chỉ ẩn bằng CSS, không đổi
  `textTracks[].mode`, nên bước lấy cue từ text track vẫn hoạt động.
- **Ẩn dòng EN** (`hideEnglish`): overlay vẫn có 2 dòng nhưng dòng EN rỗng, chỉ hiện VI;
  áp dụng ngay cho cue đang hiển thị qua `renderCurrentCue()`.
- Udemy là SPA: khi chuyển bài, content script sống tiếp. Bộ theo dõi `lessonKey()`
  (mỗi 1 s) phát hiện URL đổi, huỷ lần nạp cũ (`loadToken`), xoá cue cũ và nạp bài mới —
  nhờ vậy phụ đề không chạy trên timeline của bài trước.
- Khi fullscreen, host được chuyển vào `document.fullscreenElement` (trừ khi đó là thẻ
  `<video>` — Chrome không render con của video).

## 6. Vì sao phải có native bridge

Chrome/Edge 138+ áp dụng *Local Network Access*: extension page/service worker gọi
`http://127.0.0.1:8787` sẽ treo, dù có `host_permissions` và preflight đúng. Vì vậy
extension dùng `chrome.runtime.sendNativeMessage`; Chrome spawn `native_host.bat`/`.sh`
và nói chuyện bằng framing native messaging:

```
4-byte little-endian length | JSON UTF-8
```

Firefox không có ràng buộc này: `background.js` gọi thẳng
`http://127.0.0.1:8787` bằng `fetch` (cần host permission `http://127.0.0.1/*`,
Firefox MV3 cấp theo kiểu opt-in trong `about:addons`). Vì vậy Firefox không cần cài
native host, còn Chrome/Edge thì bắt buộc.

Các message:

| Hướng | Message | Trả lời |
|---|---|---|
| extension → host | `{"type":"info"}` | `{"type":"info","health":{...}}` |
| extension → host | `{"type":"http","method":"POST","path":"/translate-cues","body":{...},"timeout":300}` | `{"type":"http","status":200,"body":{...}}` |

Host chuyển tiếp HTTP tới server rồi thoát khi stdin đóng (Chrome kết thúc mỗi
`sendNativeMessage`). Giới hạn host→extension là 1 MB/message; bridge cắt ở 900 KB.
Server vẫn bật CORS + `Access-Control-Allow-Private-Network` để có thể gọi trực tiếp khi
phát triển.

## 7. Extension MV3

- **background.js**: cache `/health` 5 s, gom request dịch, log debug vào
  `chrome.storage.session`, giữ setting `captions`. Không giữ state capture.
  Một file chạy được cả hai: Chrome/Edge dùng `background.service_worker`, Firefox dùng
  `background.scripts` (event page); listener đăng ký ở top-level và state nằm trong storage.
- **content.js**: lấy cue, gọi dịch, vẽ overlay, theo dõi `currentTime`, cache theo bài.
- **popup**: trạng thái server, toggle phụ đề, Nạp/Tắt transcript, nhật ký debug.
- Không dùng `tabCapture`, `offscreen`, WebSocket hay audio playback.

## 8. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Chưa cấu hình key | `/health` báo `llm_translate:false`; `/translate-cues` trả 503; popup cảnh báo |
| LLM 429/quá tải | Batch bị chia đôi và thử lại; extension cũng thử lại 1 lần sau 1.2 s |
| LLM trả thiếu dòng | Server dịch lại từng dòng; dòng nào lỗi giữ nguyên tiếng Anh |
| Bridge chưa cài | `sendNativeMessage` lỗi; popup hướng dẫn chạy installer |
| Server chưa chạy | `info` trả error; popup báo “Server chưa chạy” |
| Không tìm thấy cue | Content script báo lỗi kèm chẩn đoán (số textTrack, cue DOM, mẫu HTML) |
| Tab mở trước khi cài extension | Popup inject lại `content.js` bằng `chrome.scripting` |

## 9. Bảo mật

- API key chỉ nằm ở server (`server/.env`, đã gitignore); extension không bao giờ thấy key.
- Server chỉ bind `127.0.0.1`.
- Native host chỉ chấp nhận origin `chrome-extension://aolmedionghaakdlplcmabekkpbaiedc/`
  (đăng ký trong manifest của host).

## 10. Hướng mở rộng

- Dịch theo lô lớn hơn + ngữ cảnh vài câu trước để đại từ nhất quán hơn.
- Glossary riêng theo khoá học (popup nạp file).
- Xuất SRT cho bài đã học.
- Cache có TTL/phiên bản để tự dịch lại khi đổi model.
