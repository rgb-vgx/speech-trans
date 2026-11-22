# Kiến trúc SpeechTrans

Tài liệu này giải thích cách hệ thống hoạt động, các đánh đổi đã chọn và những chỗ
cần sửa khi mở rộng. Code tương ứng nằm trong `server/app/` và `extension/src/`.

## 1. Mục tiêu và ràng buộc

| Yêu cầu | Cách đáp ứng |
|---|---|
| Dịch bài giảng Udemy (tiếng Anh) realtime | Pipeline VAD → ASR → MT → TTS chạy local trên GPU |
| Phụ đề tiếng Việt dễ đọc khi đang xem | Overlay shadow DOM, 2 dòng EN/VI, tự ẩn sau 25 s |
| Nghe được bản dịch | TTS tiếng Việt stream theo từng chunk 48 kHz |
| Không gửi dữ liệu ra ngoài | Mọi model chạy local; chỉ tải model một lần từ HF |
| Không làm mất tiếng giảng viên | Audio capture được re-route ra loa, duck khi TTS nói |
| Chịu được tab chuyển trang, mất mạng | Auto-reconnect WS, backpressure drop, VAD force-cut |

Ràng buộc cứng: Chrome MV3 (service worker có thể bị kill), audio tab chỉ lấy được qua
`tabCapture`, và GPU 12 GB phải chứa cả 3 model cùng lúc.

## 2. Luồng dữ liệu

```
┌──────────── Udemy tab ────────────┐
│ <video> phát bài giảng            │
└───────────────┬───────────────────┘
                │ tabCapture (streamId từ service worker)
┌───────────────▼───────────────────┐
│ offscreen document                │
│  MediaStreamSource ─┬─► captureGain ─► destination   (giữ tiếng gốc)
│                     └─► AudioWorklet (16 kHz int16, 100 ms/frame)
│  chrome.runtime.connectNative ─► PCM lên bridge (base64)
│  AudioBuffer scheduler ◄──────── PCM 48 kHz từ bridge
└───────────────┬───────────────────┘
                │ stdio (native messaging framing)
┌───────────────▼───────────────────┐
│ server/app/native_host.py         │  (Chrome spawn, mỗi phiên capture)
│  stdin/stdout JSON  ◄─►  WS client│
└───────────────┬───────────────────┘
                │ ws://127.0.0.1:8787/ws
┌───────────────▼───────────────────┐
│ FastAPI server                    │
│  VAD (Silero) ─► ASR (Whisper)    │
│                 ─► MT (NLLB)      │
│                 ─► TTS (VieNeu)   │
└───────────────────────────────────┘
```

Mỗi stage là một `asyncio.Task` riêng với queue riêng (`Session` trong
[pipeline.py](../server/app/pipeline.py)), nhờ vậy câu *n+1* được ASR trong khi câu *n*
đang được dịch/đọc. Thứ tự được giữ vì mỗi stage xử lý tuần tự.

## 3. Vì sao chọn từng model

| Stage | Model | Lý do |
|---|---|---|
| VAD | Silero VAD (ONNX) | Nhẹ, chạy CPU, phát hiện speech ổn định; cần để cắt câu theo khoảng lặng |
| ASR | faster-whisper `large-v3` int8_float16 | Chính xác với thuật ngữ; RTF ~0.09 trên 3060; đã có cache |
| MT | NLLB-200-distilled-1.3B | Dịch chuyên dụng, ổn định, ~230 ms/câu, không tốn VRAM như LLM 9B |
| TTS | VieNeu-TTS v3 Turbo | Tiếng Việt native, 48 kHz, streaming TTFA ~116 ms, 25 giọng |

Đo thực tế (câu thứ 2 trở đi, cả 3 model cùng resident): ASR 380–470 ms cho 4–5 s audio,
MT 225–270 ms, TTS 116 ms tới audio đầu tiên, VRAM ~6.6/12 GB.

**Vì sao không dùng LLM dịch?** Qwen3.5 9B chất lượng ngữ cảnh tốt hơn nhưng chiếm thêm
~6.5 GB VRAM và 0.5–1 s/câu; với 12 GB thì phải bỏ Whisper large-v3 hoặc TTS GPU. NLLB
là điểm cân bằng tốt nhất cho realtime. (Có thể đổi sang OpenAI-compatible endpoint sau
này mà không đổi protocol.)

## 4. Cắt câu (VAD) — quyết định quan trọng nhất về độ trễ

`VADSegmenter` chạy cửa sổ 512 mẫu (32 ms), có hysteresis:

- bắt đầu câu khi `prob ≥ threshold` (mặc định 0.5), kèm pre-roll 200 ms;
- đóng câu khi im lặng ≥ `min_silence_ms` (350 ms) → **đây là phần trễ cố hữu**;
- force-cut ở `max_segment_s` (12 s) để người nói liên tục không chặn pipeline;
- segment < 250 ms voiced bị bỏ (tiếng ho, click).

Giảm `min_silence_ms` xuống 200 ms sẽ phản hồi nhanh hơn nhưng dễ cắt giữa câu khi
giảng viên ngừng thở — đây là tham số đầu tiên nên thử khi tinh chỉnh.

## 5. Vận chuyển: native messaging thay cho WebSocket trực tiếp

**Phát hiện khi tích hợp:** Chrome 138+ áp dụng *Local Network Access*; request
từ extension tới loopback bị treo vĩnh viễn. Đã kiểm chứng trên Chrome 158 /
Chromium 152+: `fetch('http://127.0.0.1:8787')`, `http://localhost:8787` và
`ws://…/ws` từ cả service worker lẫn extension page đều treo, dù có
`host_permissions`, preflight `Access-Control-Request-Private-Network` trả đúng,
hay có user gesture. Một trang web thường thì vẫn gọi được localhost — nên đây là
chính sách riêng cho extension origin.

Vì vậy extension không mở socket; nó dùng `chrome.runtime.connectNative`:

```
extension  ──4-byte LE length + JSON──►  native_host.py (stdio)
                                           │
                                           └─ WebSocket ─► FastAPI :8787
```

- Uplink: `{"type":"audio","data":<base64 int16 PCM>}` mỗi 100 ms.
- Xuống: `{"type":"event","payload":<server JSON>}` và
  `{"type":"audio","id":n,"data":<base64>}`.
- `{"type":"info"}` trả `{health, voices}` để popup hiển thị trạng thái mà không
  cần kết nối capture.
- Giới hạn của Chrome: host→extension ≤ 1 MB/message (bridge cắt ở 900 KB),
  extension→host lớn hơn nhiều; audio chunk thực tế chỉ vài KB.

Server vẫn nói WebSocket thuần để `scripts/ws_client.py` và các client khác dùng
lại được; bridge chỉ là một client.

## 6. Giao thức server ↔ bridge (WebSocket)

Một kết nối duy nhất, multiplex text (JSON) và binary (PCM).

**Client → server**

```
binary : 0x01 | int16 LE PCM, 16 kHz mono, 100 ms/frame
text   : {"type":"config","tts":bool,"voice":str}
         {"type":"interrupt"}
         {"type":"ping","t":<ms>}
```

**Server → client**

```
text   : {"type":"config","input_sample_rate":16000,"tts_sample_rate":48000,
          "tts_enabled":bool,"tts_voice":str,"voices":[...]}
         {"type":"speech","state":"end","id":n,"duration":s}
         {"type":"asr","id":n,"text":en,"duration":s,"elapsed_ms":ms}
         {"type":"translation","id":n,"text":vi,"elapsed_ms":ms,"total_ms":ms}
         {"type":"tts","state":"start"|"end"|"stop","id":n}
         {"type":"status"|"error"|"pong"}
binary : 0x02 | uint32 LE utterance id | int16 LE PCM, 48 kHz mono
```

`total_ms` đo từ lúc VAD chốt câu đến khi có bản dịch — chính là chỉ số "trễ cảm nhận"
trừ phần TTS. `utt id` cho phép client ghép audio với phụ đề và replay.

Code hoá/giải mã nằm ở [protocol.py](../server/app/protocol.py); client tham chiếu ở
[scripts/ws_client.py](../server/scripts/ws_client.py).

## 7. Thuật ngữ (glossary)

`glossary.json` chứa `{term: target}`. Trước khi dịch, thuật ngữ được thay bằng sentinel
`XQZ<n>` để NLLB không "dịch" nó; sau khi dịch, sentinel được thay lại bằng target
(rỗng = giữ nguyên tiếng Anh). Regex cho phép khoảng trắng bị chèn vào giữa marker
(`xqz 0`) vì tokenizer có thể tách.

Giới hạn: nếu model làm mất marker, thuật ngữ đó sẽ biến mất khỏi output — hiếm nhưng
có thể xảy ra với câu quá dài. Đây là lý do `max_input_tokens` được chia nhỏ theo câu.

## 8. Extension MV3

- **Service worker** chỉ giữ state (tab đang capture, config) và route message; nó có
  thể bị kill bất kỳ lúc nào nên state được persist trong `chrome.storage.session`.
- **Offscreen document** (`reasons: USER_MEDIA + AUDIO_PLAYBACK`) giữ capture, native
  port và playback — sống chừng nào còn capture, nên không bị kill như service worker.
- **Native port** do offscreen mở; bridge nối tiếp tới server qua WebSocket. Khi
  bridge chết, `onDisconnect` + backoff 1→10 s tự nối lại và gửi lại config.
- **Popup** không tự fetch localhost (bị LNA chặn); nó hỏi background, background
  dùng `chrome.runtime.sendNativeMessage({type:"info"})` và cache 5 s.
- **Vì sao phải re-route audio:** `tabCapture` lấy audio ra khỏi output thường; nếu không
  nối `source → gain → destination`, tab sẽ im lặng. Gain này cũng là chỗ ducking.
- **Resampler** là AudioWorklet: trung bình 2 kênh, nội suy tuyến tính về 16 kHz, gom
  đúng 1600 mẫu rồi post transferable `ArrayBuffer`.
- **Playback** schedule bằng `AudioBufferSourceNode` với `nextPlayTime`; nếu backlog
  vượt 4 s (TTS chậm hơn người nói) thì nhảy về `currentTime` để không trễ dây chuyền.
- **Overlay** nằm trong shadow root để CSS Udemy không ảnh hưởng; khi fullscreen, host
  được chuyển vào `document.fullscreenElement` (trừ khi đó là thẻ `<video>` — Chrome
  không render con của video).
- **Replay** dùng audio PCM đã lưu theo `utt id` ở offscreen (giới hạn 60 MB), không
  cần gửi base64 qua content script.
- **Transcript + độ trễ**: service worker gom ASR/dịch/TTS theo `utt id` vào
  `chrome.storage.session`, đẩy sang trang `src/transcript.html` (tab riêng) và popup.
  Hai chỉ số do hai phía đo: `total_ms` (server: chốt câu → có bản dịch) và `ttfa`
  (extension: có bản dịch → audio TTS đầu tiên); cộng lại là độ trễ người dùng cảm nhận.
- **Lưu vết phía server**: mỗi câu được ghi thành một dòng JSONL trong
  `logs/transcripts/YYYY-MM-DD.jsonl` (utterance + tts).

## 9. Xử lý lỗi và backpressure

| Tình huống | Hành vi |
|---|---|
| Audio tới khi model chưa nạp xong | **Bị drop** (đếm và log), không đưa vào VAD — tránh backlog hàng phút và tránh race với preload |
| Hai luồng cùng gọi `load()` | Mỗi model có `_load_lock` (double-checked) — trước đây NLLB bị nạp 2 lần và tokenizer lỗi `Already borrowed` |
| TTS queue đầy (client chậm/interrupt) | `_tts_queue` max 3, bỏ câu cũ nhất; queue chunk trong `stream()` max 64, producer tự dừng |
| Chunk TTS cũ sau interrupt | `_tts_generation` tăng khi interrupt; worker kiểm tra trước mỗi lần gửi |
| Playback tụt lại | Soft 3 s: bỏ các chunk chưa phát của câu cũ; Hard 5 s: thêm `interrupt` để server ngừng tổng hợp; chunk đang đọc luôn được đọc hết |
| Service worker bị restart giữa chừng | Watchdog 5 s ở offscreen mở lại bridge; state nằm trong `chrome.storage.session` |
| Server chưa chạy | bridge báo `disconnected` → overlay đỏ, tự thử lại 2 s/lần |
| Bridge chưa cài / bị gỡ | `connectNative` lỗi → popup hướng dẫn chạy installer |
| Model đang nạp | `/health` trả `loading`; audio vẫn nhận, ASR chờ model sẵn sàng |
| Tab đóng / dừng chia sẻ | track `ended` → dọn tài nguyên, báo `capture-ended` |
| ASR/MT/TTS lỗi | gửi `error` event, session vẫn sống |
| Server chậm hơn thời gian thực | `Session` giữ tối đa 6 segment, bỏ segment cũ nhất; client bỏ frame khi buffer > 2 MB |
| User tắt TTS | `interrupt` → dừng audio đang phát, xoá queue |
| Câu quá dài | force-cut 12 s, ASR vẫn chạy trên từng phần |

## 10. Chi phí khởi động

Lần đầu mỗi model rất chậm (cuDNN autotune, CUDA graph capture): ASR ~4 s, MT ~10 s,
TTS ~5 s cho request đầu. Vì vậy `PipelineServices.load_blocking()` gọi `warmup()` hai
lần cho mỗi model, chạy trong background task lúc server start. Tổng thời gian từ lúc
chạy lệnh đến `status: ok` khoảng 20–60 s (đã có model trong cache).

## 11. Hướng mở rộng

- **Streaming ASR** (LocalAgreement / whisper-streaming) để bắt đầu dịch trước khi câu
  kết thúc — cải thiện cảm giác realtime, phức tạp hơn nhiều.
- **Ngữ cảnh dịch**: cache 2–3 câu trước và đưa vào prompt nếu chuyển sang LLM; sửa đại
  từ và thuật ngữ nhất quán.
- **Glossary theo khoá học**: cho phép popup nạp glossary riêng cho từng course.
- **Xuất phụ đề SRT** cho bài đã học (dữ liệu đã có trong overlay/offscreen).
- **Chọn nguồn audio**: thêm chế độ loopback toàn hệ thống (PulseAudio) cho trình duyệt
  khác hoặc video ngoài Udemy.
