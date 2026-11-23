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

Chuẩn bị: server chạy; Firefox đã Load Temporary Add-on, hoặc Chrome/Edge đã cài native
host và khởi động lại; extension đã nạp.

1. **Popup**: server hiện “Server sẵn sàng · deepseek-v4.1-flash”.
2. **Tự nạp**: mở bài giảng (đã từng học hoặc mở panel Transcript) → phụ đề hiện sau khi
   dịch xong; các lần sau mở lại thấy ngay từ cache.
3. **Phụ đề**: dòng EN (nhỏ) + VI (lớn) ở đáy video, đổi đúng theo lúc video phát, kể cả
   khi pause/seek; hết câu trong khoảng lặng thì ẩn (không giữ câu cũ).
4. **Canh thời gian**: chỉnh ô Canh thời gian +1 s / −1 s → phụ đề dịch sớm/trễ tương ứng,
   áp dụng ngay và giữ sau khi mở lại popup.
5. **Vị trí**: kéo thanh Vị trí phụ đề lên/xuống → khối EN/VI dời theo ngay, kể cả khi
   fullscreen; mở lại popup vẫn giữ giá trị.
6. **Chuyển bài (SPA)**: bấm bài tiếp theo không reload trang → phụ đề bài cũ phải biến
   mất và bài mới tự nạp (cache hoặc dịch lại), không chạy tiếp timeline cũ.
7. **Ẩn phụ đề gốc**: bật toggle → phụ đề tiếng Anh của Udemy biến mất, overlay EN/VI vẫn
   chạy; tắt toggle → phụ đề Udemy hiện lại.
8. **Ẩn dòng EN**: bật toggle → overlay chỉ còn dòng VI, kể cả với cue đang hiển thị; tắt
   → dòng EN hiện lại.
9. **Toggle**: tắt **Phụ đề** trong popup → overlay ẩn; bật lại → hiện.
10. **Nạp lại**: bấm **Nạp** → trạng thái “Đang dịch x/y câu…” (hoặc “sẵn sàng” nếu cache).
11. **Tắt**: bấm **Tắt** → phụ đề ẩn, không còn cập nhật theo video.
12. **Fullscreen**: fullscreen của player Udemy → overlay vẫn hiện (fullscreen trực tiếp
    thẻ `<video>` là giới hạn của Chrome).
13. **Server tắt**: dừng server → popup báo “Server chưa chạy”; bật lại → kiểm tra lại OK.
14. **Thiếu key**: xoá `ST_LLM_API_KEY` → popup báo “Server thiếu ST_LLM_API_KEY”,
    `/translate-cues` trả 503.
15. **Bài không có caption**: extension báo không thấy cue kèm chẩn đoán; mở panel
    Transcript rồi bấm Nạp.
16. **Log**: `logs/server-*.log`, `logs/native-host.log`, `logs/client.log` có bản ghi
    tương ứng; popup → Nhật ký debug → Sao chép được.
