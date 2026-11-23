

const $ = (id) => document.getElementById(id);
const els = {
  server: $("server"),
  serverDot: $("serverDot"),
  serverText: $("serverText"),
  toggleBtn: $("toggleBtn"),
  captionsToggle: $("captionsToggle"),
  hint: $("hint"),
  captureStatus: $("captureStatus"),
  logText: $("logText"),
  logCount: $("logCount"),
  copyLog: $("copyLog"),
  clearLog: $("clearLog"),
  lastUtterance: $("lastUtterance"),
  openTranscript: $("openTranscript"),
  transcriptStatus: $("transcriptStatus"),
  loadTranscript: $("loadTranscript"),
  clearTranscript: $("clearTranscript"),
};

function describeUtterance(row) {
  if (!row) return "Chưa có câu nào";
  const parts = [`#${row.id}`];
  if (Number.isFinite(row.totalMs)) parts.push(`tổng ${Math.round(row.totalMs)}ms`);
  return parts.join(" · ");
}

let status = null;
let logEntries = [];

function fmtTime(ms) {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function esc(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function renderLog() {
  if (!els.logText) return;
  if (!logEntries.length) {
    els.logText.textContent = "(chưa có log)";
    els.logCount.textContent = "";
    return;
  }
  els.logText.innerHTML = logEntries
    .map((entry) => {
      const time = fmtTime(entry.t);
      const extra = entry.extra ? " " + esc(JSON.stringify(entry.extra)) : "";
      const cls = entry.scope === "error" ? ' class="err"' : "";
      return `<span${cls}>${time} [${esc(entry.scope)}] ${esc(entry.message)}${extra}</span>`;
    })
    .join("\n");
  els.logCount.textContent = `(${logEntries.length})`;
  els.logText.scrollTop = els.logText.scrollHeight;
}

function appendLog(entry) {
  logEntries.push(entry);
  if (logEntries.length > 200) logEntries = logEntries.slice(-200);
  renderLog();
}

async function loadLog() {
  try {
    const response = await send({ type: "get-log" });
    if (response && Array.isArray(response.entries)) {
      logEntries = response.entries;
      renderLog();
    }
  } catch {
    /* ignore */
  }
}

function setCapture(text, kind = "") {
  if (!els.captureStatus) return;
  els.captureStatus.classList.remove("err", "ok");
  if (kind) els.captureStatus.classList.add(kind);
  els.captureStatus.textContent = text;
}

function send(message) {
  return chrome.runtime.sendMessage({ from: "popup", ...message });
}

function showError(message) {
  els.hint.classList.add("error");
  els.hint.textContent = message;
  setCapture(message, "err");
}

function showHint(message) {
  els.hint.classList.remove("error");
  els.hint.textContent = message;
}

function setServer(state, text) {
  els.serverDot.classList.remove("ok", "err");
  if (state === "ok") els.serverDot.classList.add("ok");
  else if (state === "err") els.serverDot.classList.add("err");
  els.serverText.textContent = text;
}

function render() {
  const running = Boolean(status && status.running);
  els.toggleBtn.textContent = running ? "Dừng" : "Bắt đầu";
  els.toggleBtn.classList.toggle("stop", running);
  els.toggleBtn.disabled = false;

  const config = (status && status.config) || {};
  els.captionsToggle.checked = config.captions !== false;

  if (running) {
    const server = (status && status.server) || {};
    if (server.state === "error" || server.state === "disconnected") {
      setCapture(server.detail || server.state, "err");
    } else if (server.state === "connected") {
      setCapture("Đang dịch phụ đề", "ok");
    } else if (server.state === "capturing") {
      setCapture("Đang khởi động thu âm…");
    } else {
      setCapture("Đang chạy, chờ kết nối server…");
    }
  } else {
    setCapture("Chưa bắt đầu");
  }
}

async function refreshStatus() {
  try {
    const next = await send({ type: "get-status" });
    if (next && !next.error) {
      status = next;
      render();
    } else if (next && next.error) {
      showError(next.error);
      els.toggleBtn.disabled = false;
    }
  } catch (error) {
    showError(String(error));
  }
}

async function refreshHealth() {
  let info;
  try {
    info = await send({ type: "server-info" });
  } catch (error) {
    setServer("err", "Bridge chưa cài (chạy scripts/install_native_host.py)");
    return;
  }
  if (!info || info.error) {
    setServer("err", "Server chưa chạy (localhost:8787)");
    return;
  }
  const health = info.health || {};
  const gpu = health.gpu || {};
  const vram = gpu.vram_free_mb ? `${(gpu.vram_free_mb / 1024).toFixed(1)} GB VRAM trống` : "";
  const live = health.live_enabled !== false;
  els.toggleBtn.style.display = live ? "" : "none";
  els.captureStatus.style.display = live ? "" : "none";
  if (!live) showHint("Chế độ live đã tắt (server chạy transcript-only) — chỉ hiện phụ đề transcript.");

  if (health.status === "ok") {
    setServer("ok", `Server sẵn sàng${vram ? " · " + vram : ""}`);
  } else {
    setServer("warn", "Server đang nạp model… (có thể mất 30–60s)");
  }
}

async function toggle() {
  els.toggleBtn.disabled = true;
  const wasRunning = Boolean(status && status.running);
  try {
    let result;
    if (wasRunning) {
      result = await send({ type: "stop" });
    } else {
      // Mint the stream id here: this click is a user gesture and the action
      // click already granted activeTab, which tabCapture requires. Doing it
      // from the service worker loses that context on some Chrome versions.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id === undefined) throw new Error("Không tìm thấy tab đang mở.");
      if (!tab.url || !/^https:\/\/([a-z0-9-]+\.)*udemy\.com\//i.test(tab.url)) {
        throw new Error("Hãy mở trang bài giảng Udemy trên tab đang active.");
      }
      let streamId;
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      } catch (error) {
        throw new Error(
          `Chrome không cho thu tab này: ${error && error.message ? error.message : error}. ` +
            "Thử bấm lại sau khi click vào video, hoặc reload trang Udemy."
        );
      }
      result = await send({ type: "start", streamId, tabId: tab.id });
    }

    if (result && result.error) showError(result.error);
    else {
      showHint(
        wasRunning
          ? "Đã dừng."
          : "Đang chạy. Phụ đề hiện phía trên video; bật “Đọc bản dịch” để nghe tiếng Việt."
      );
      status = result;
      render();
    }
  } catch (error) {
    // Keep the error visible in the status line (render would clear it).
    showError(String(error && error.message ? error.message : error));
  } finally {
    els.toggleBtn.disabled = false;
  }
}

async function updateConfig(patch) {
  const result = await send({ type: "set-config", config: patch });
  if (result && result.error) showError(result.error);
  else if (result && result.config) {
    status = { ...(status || {}), config: result.config };
    render();
  }
}

els.toggleBtn.addEventListener("click", toggle);
els.captionsToggle.addEventListener("change", () =>
  updateConfig({ captions: els.captionsToggle.checked })
);

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "log" && message.entry) {
    appendLog(message.entry);
    return;
  }
  if (message.type === "utterance" && message.row) {
    els.lastUtterance.textContent = describeUtterance(message.row);
    return;
  }
  if (message.type !== "popup-event") return;
  const payload = message.payload || {};
  if (payload.type === "transcript-status") {
    els.transcriptStatus.textContent = payload.text || "";
    return;
  }
  if (payload.type === "status") {
    status = { ...(status || {}), server: payload };
    render();
    if (payload.state === "error" && payload.detail) showError(payload.detail);
  }
});

els.copyLog.addEventListener("click", async () => {
  const text = logEntries
    .map((e) => `${fmtTime(e.t)} [${e.scope}] ${e.message}${e.extra ? " " + JSON.stringify(e.extra) : ""}`)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text || "(no log)");
    els.copyLog.textContent = "Đã copy";
    setTimeout(() => (els.copyLog.textContent = "Sao chép"), 1200);
  } catch (error) {
    showError(`Không copy được: ${error}`);
  }
});

els.clearLog.addEventListener("click", async () => {
  logEntries = [];
  renderLog();
  await send({ type: "clear-log" }).catch(() => {});
});

els.openTranscript.addEventListener("click", () => {
  send({ type: "open-transcript" }).catch(() => {});
});

const UDEMY_URL = /^https:\/\/([a-z0-9-]+\.)*udemy\.com\//i;

async function toActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) throw new Error("Không tìm thấy tab đang mở.");
  if (!tab.url || !UDEMY_URL.test(tab.url)) {
    throw new Error("Tab đang active không phải bài giảng Udemy — mở trang bài giảng rồi bấm lại.");
  }
  try {
    await chrome.tabs.sendMessage(tab.id, message);
    return;
  } catch (error) {
    const text = String(error && error.message ? error.message : error);
    if (!/Receiving end does not exist|Could not establish connection/i.test(text)) throw error;
  }
  // Content script not present (tab opened before install/reload): inject it now.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content.js"] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    throw new Error(`Không inject được content script: ${error && error.message ? error.message : error}`);
  }
}

els.loadTranscript.addEventListener("click", async () => {
  els.transcriptStatus.textContent = "Đang nạp transcript…";
  try {
    await toActiveTab({ type: "transcript-load" });
  } catch (error) {
    els.transcriptStatus.textContent = "Lỗi: hãy mở trang bài giảng Udemy và reload tab";
    showError(String(error));
  }
});

els.clearTranscript.addEventListener("click", async () => {
  try {
    await toActiveTab({ type: "transcript-clear" });
    els.transcriptStatus.textContent = "Đã tắt";
  } catch {
    /* tab không phải Udemy */
  }
});

async function loadLastUtterance() {
  try {
    const response = await send({ type: "get-transcript" });
    const rows = (response && response.rows) || [];
    if (rows.length) els.lastUtterance.textContent = describeUtterance(rows[rows.length - 1]);
  } catch {
    /* ignore */
  }
}

async function loadTranscriptState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) return;
    const state = await chrome.tabs.sendMessage(tab.id, { type: "transcript-state" });
    if (state && state.enabled) {
      els.transcriptStatus.textContent = `Đang hiện phụ đề transcript (${state.cues} câu)`;
    } else if (state) {
      els.transcriptStatus.textContent = "Chưa nạp cho bài này";
    }
  } catch {
    /* not a lecture page */
  }
}

refreshStatus();
refreshHealth();
loadTranscriptState();
loadLog();
loadLastUtterance();
setInterval(refreshHealth, 4000);
