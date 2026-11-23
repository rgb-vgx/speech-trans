# Kiểm thử

## Tự động

```bash
cd server
uv run pytest -q
```

Bộ test hiện tại:

- `tests/test_llm.py` — parse JSON của LLM, chia batch, giữ thứ tự, giữ nguyên câu khi
  lỗi, `/health` và `/translate-cues` (200/503).
- `tests/conftest.py` — trỏ log vào thư mục tạm.

Kiểm tra tay server (không cần trình duyệt):

```bash
curl -s http://localhost:8787/health
curl -s -X POST http://localhost:8787/translate-cues \
  -H "Content-Type: application/json" \
  -d '{"cues":["Hello everyone, welcome to the course."]}'
```

Bridge (native messaging framing) có thể kiểm tra bằng script Python nhỏ: mở
`native_host.bat`/`.sh` với stdin/stdout là pipe, gửi
`4-byte LE length + {"type":"info"}` và đọc phản hồi. Kỳ vọng:
`{"type":"info","health":{"status":"ok",...}}`.

## Checklist thủ công trên Udemy

Chuẩn bị: server chạy, đã cài native host, browser đã khởi động lại, extension đã Load
unpacked.

1. **Popup**: server hiện “Server sẵn sàng · deepseek-v4.1-flash”.
2. **Tự nạp**: mở bài giảng (đã từng học hoặc mở panel Transcript) → phụ đề hiện sau khi
   dịch xong; các lần sau mở lại thấy ngay từ cache.
3. **Phụ đề**: dòng EN (nhỏ) + VI (lớn) ở đáy video, đổi đúng theo lúc video phát, kể cả
   khi pause/seek.
4. **Toggle**: tắt **Phụ đề** trong popup → overlay ẩn; bật lại → hiện.
5. **Nạp lại**: bấm **Nạp** → trạng thái “Đang dịch x/y câu…” (hoặc “sẵn sàng” nếu cache).
6. **Tắt**: bấm **Tắt** → phụ đề ẩn, không còn cập nhật theo video.
7. **Fullscreen**: fullscreen của player Udemy → overlay vẫn hiện (fullscreen trực tiếp
   thẻ `<video>` là giới hạn của Chrome).
8. **Server tắt**: dừng server → popup báo “Server chưa chạy”; bật lại → kiểm tra lại OK.
9. **Thiếu key**: xoá `ST_LLM_API_KEY` → popup báo “Server thiếu ST_LLM_API_KEY”,
   `/translate-cues` trả 503.
10. **Bài không có caption**: extension báo không thấy cue kèm chẩn đoán; mở panel
    Transcript rồi bấm Nạp.
11. **Log**: `logs/server-*.log`, `logs/native-host.log`, `logs/client.log` có bản ghi
    tương ứng; popup → Nhật ký debug → Sao chép được.
