/** Popup: server status, caption toggle, transcript load/clear, debug log. */

const $ = (id) => document.getElementById(id);
const els = {
  serverDot: $("serverDot"),
  serverText: $("serverText"),
  captionsToggle: $("captionsToggle"),
  hint: $("hint"),
  logText: $("logText"),
  logCount: $("logCount"),
  copyLog: $("copyLog"),
  clearLog: $("clearLog"),
  transcriptStatus: $("transcriptStatus"),
  loadTranscript: $("loadTranscript"),
  clearTranscript: $("clearTranscript"),
};

let logEntries = [];

function send(message) {
  return chrome.runtime.sendMessage({ from: "popup", ...message });
}

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

function showError(message) {
  els.hint.classList.add("error");
  els.hint.textContent = message;
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

async function refreshHealth() {
  let info;
  try {
    info = await send({ type: "server-info", force: true });
  } catch (error) {
    setServer("err", "Bridge chưa cài (chạy scripts/install_native_host.py)");
    return;
  }
  if (!info || info.error) {
    setServer("err", "Server chưa chạy (localhost:8787)");
    return;
  }
  const health = info.health || {};
  if (health.status !== "ok") {
    setServer("", "Server chưa sẵn sàng");
    return;
  }
  if (health.llm_translate === false) {
    setServer("err", "Server thiếu ST_LLM_API_KEY");
    return;
  }
  setServer("ok", `Server sẵn sàng · ${health.model || "LLM"}`);
}

async function loadConfig() {
  try {
    const config = await send({ type: "get-config" });
    if (config && typeof config.captions === "boolean") els.captionsToggle.checked = config.captions;
  } catch {
    /* ignore */
  }
}

async function updateConfig(patch) {
  try {
    const result = await send({ type: "set-config", config: patch });
    if (result && result.error) showError(result.error);
    else if (result && result.config) els.captionsToggle.checked = result.config.captions !== false;
  } catch (error) {
    showError(String(error));
  }
}

els.captionsToggle.addEventListener("change", () =>
  updateConfig({ captions: els.captionsToggle.checked })
);

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "log" && message.entry) {
    appendLog(message.entry);
    return;
  }
  if (message.type !== "popup-event") return;
  const payload = message.payload || {};
  if (payload.type === "transcript-status") {
    els.transcriptStatus.textContent = payload.text || "";
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

refreshHealth();
loadConfig();
loadTranscriptState();
loadLog();
setInterval(refreshHealth, 4000);
