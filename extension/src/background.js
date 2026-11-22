/**
 * Service worker: owns tab capture lifecycle and routes messages between the
 * popup, the offscreen document (capture + WebSocket + playback) and the
 * content script (subtitle overlay).
 */

const NATIVE_HOST = "com.speechtrans.bridge";
const OFFSCREEN_URL = "src/offscreen.html";
const INFO_TTL_MS = 5000;

const DEFAULT_CONFIG = {
  captions: true,
};

/** @type {{running: boolean, tabId: number|null, config: typeof DEFAULT_CONFIG, server: object|null}} */
let state = { running: false, tabId: null, config: { ...DEFAULT_CONFIG }, server: null };

// --- debug log ---------------------------------------------------------
const LOG_LIMIT = 200;
let logs = [];

function log(scope, message, extra = null) {
  const entry = { t: Date.now(), scope, message, extra };
  logs.push(entry);
  if (logs.length > LOG_LIMIT) logs.shift();
  try {
    console.log(`[st:${scope}] ${message}`, extra ?? "");
  } catch {
    /* ignore */
  }
  chrome.storage.session.set({ debugLog: logs }).catch(() => {});
  chrome.runtime.sendMessage({ from: "background", type: "log", entry }).catch(() => {});
}

async function restoreLog() {
  const { debugLog, utterances: stored } = await chrome.storage.session.get(["debugLog", "utterances"]);
  if (Array.isArray(debugLog)) logs = debugLog.slice(-LOG_LIMIT);
  if (Array.isArray(stored)) utterances = stored.slice(-MAX_UTTERANCES);
}

// --- transcript + latency store ----------------------------------------
const MAX_UTTERANCES = 120;
let utterances = [];

function upsertUtterance(id, patch) {
  if (id === undefined || id === null) return;
  let row = utterances.find((item) => item.id === id);
  if (!row) {
    row = { id, at: Date.now(), ...patch };
    utterances.push(row);
    if (utterances.length > MAX_UTTERANCES) utterances = utterances.slice(-MAX_UTTERANCES);
  } else {
    Object.assign(row, patch);
  }
  chrome.storage.session.set({ utterances }).catch(() => {});
  chrome.runtime.sendMessage({ from: "background", type: "utterance", row }).catch(() => {});
}

function recordEvent(payload) {
  if (!payload || payload.id === undefined) return;
  if (payload.type === "asr") {
    upsertUtterance(payload.id, {
      en: payload.text,
      duration: payload.duration,
      asrMs: payload.elapsed_ms,
    });
  } else if (payload.type === "translation") {
    upsertUtterance(payload.id, {
      vi: payload.text,
      mtMs: payload.elapsed_ms,
      totalMs: payload.total_ms,
    });
  }
}

// --- native messaging bridge (must live here) ---------------------------
// Offscreen documents do not expose chrome.runtime.connectNative; the service
// worker owns the port and relays messages to/from the offscreen document.
let nativePort = null;
let nativeRetryTimer = null;

function ensureNativePort() {
  if (nativePort) return true;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (error) {
    log("error", `connectNative failed: ${error && error.message ? error.message : error}`);
    return false;
  }
  log("bridge", "native port opened");
  nativePort.onMessage.addListener((message) => {
    chrome.runtime.sendMessage({ from: "background", type: "bridge-message", message }).catch(() => {});
  });
  nativePort.onDisconnect.addListener(() => {
    const detail = chrome.runtime.lastError && chrome.runtime.lastError.message;
    nativePort = null;
    log("error", `native port closed${detail ? ": " + detail : ""}`);
    chrome.runtime
      .sendMessage({ from: "background", type: "bridge-disconnected", detail: detail || null })
      .catch(() => {});
    if (state.running) scheduleNativeReconnect();
  });
  return true;
}

function closeNativePort() {
  const port = nativePort;
  nativePort = null;
  if (!port) return;
  try {
    port.disconnect();
  } catch {
    /* already closed */
  }
  log("bridge", "native port closed by request");
}

function scheduleNativeReconnect() {
  if (nativeRetryTimer) return;
  nativeRetryTimer = setTimeout(() => {
    nativeRetryTimer = null;
    if (state.running && !nativePort) ensureNativePort();
  }, 2000);
}

async function restoreState() {
  const stored = await chrome.storage.session.get(["running", "tabId", "config"]);
  if (stored.config) state.config = { ...DEFAULT_CONFIG, ...stored.config };
  state.running = Boolean(stored.running) && (await hasOffscreen());
  state.tabId = stored.tabId ?? null;
  await updateBadge();
}

async function persist() {
  await chrome.storage.session.set({
    running: state.running,
    tabId: state.tabId,
    config: state.config,
  });
}

function updateBadge() {
  const text = state.running ? "ON" : "";
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#2563eb" }).catch(() => {});
}

async function hasOffscreen() {
  if (!chrome.offscreen || !chrome.offscreen.hasDocument) return false;
  return chrome.offscreen.hasDocument();
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture Udemy lecture audio and play Vietnamese translations.",
  });
}

async function offscreenMessage(message) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ from: "background", ...message });
  if (response && response.error) throw new Error(response.error);
  return response;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) throw new Error("Không tìm thấy tab đang mở.");
  if (!tab.url || !/^https:\/\/([a-z0-9-]+\.)*udemy\.com\//i.test(tab.url)) {
    throw new Error("Hãy mở trang bài giảng Udemy rồi bấm Bắt đầu.");
  }
  return tab;
}

async function start(request = {}) {
  if (state.running) return getStatus();
  log("background", "start requested", { tabId: request.tabId, hasStreamId: Boolean(request.streamId) });
  let tab;
  try {
    tab = await getActiveTab();
  } catch (error) {
    log("background", "start rejected: active tab", String(error));
    throw error;
  }
  const tabId = request.tabId ?? tab.id;
  log("background", "capturing tab", { tabId, url: tab.url && tab.url.slice(0, 120) });

  // Order matters: the offscreen document must exist before the stream id is
  // consumed, and the id expires within seconds.
  await ensureOffscreen();
  let streamId = request.streamId;
  try {
    if (!streamId) {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      log("background", "stream id minted in service worker");
    } else {
      log("background", "using stream id minted by popup");
    }
  } catch (error) {
    log("background", "getMediaStreamId failed", String(error));
    throw error;
  }

  const response = await chrome.runtime.sendMessage({
    from: "background",
    type: "offscreen-start",
    streamId,
    tabId,
    config: state.config,
  });
  if (response && response.error) {
    log("background", "offscreen refused to start", response.error);
    throw new Error(response.error);
  }

  state.running = true;
  state.tabId = tabId;
  await persist();
  await updateBadge();
  log("background", "capture running", { tabId });
  return getStatus();
}

async function stop() {
  log("background", "stop requested");
  if (await hasOffscreen()) {
    try {
      await chrome.runtime.sendMessage({ from: "background", type: "offscreen-stop" });
    } catch {
      /* offscreen already gone */
    }
  }
  state.running = false;
  state.tabId = null;
  closeNativePort();
  await persist();
  await updateBadge();
  return getStatus();
}

async function setConfig(patch) {
  state.config = { ...state.config, ...patch };
  await persist();
  log("background", "config updated", state.config);
  if (state.running) {
    try {
      await chrome.runtime.sendMessage({
        from: "background",
        type: "offscreen-config",
        config: state.config,
      });
    } catch (error) {
      log("background", "cannot forward config to offscreen", String(error));
    }
  }
  // Let the overlay react immediately (captions toggle, TTS wording).
  await forwardToTab({ type: "config", captions: state.config.captions });
  return state.config;
}

function getStatus() {
  return {
    running: state.running,
    tabId: state.tabId,
    config: state.config,
    server: state.server,
  };
}

/** Server /health through the native bridge (the popup cannot fetch
 *  loopback URLs itself: Chrome's Local Network Access blocks it). */
let infoCache = { at: 0, value: null, inflight: null };

async function getServerInfo(force = false) {
  if (!force && infoCache.value && Date.now() - infoCache.at < INFO_TTL_MS) return infoCache.value;
  if (infoCache.inflight) return infoCache.inflight;
  infoCache.inflight = (async () => {
    try {
      const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "info" });
      infoCache = { at: Date.now(), value: response, inflight: null };
      return response;
    } catch (error) {
      const value = { error: String(error && error.message ? error.message : error) };
      infoCache = { at: Date.now(), value, inflight: null };
      return value;
    }
  })();
  return infoCache.inflight;
}

async function forwardToTab(payload) {
  if (state.tabId === null) return;
  try {
    await chrome.tabs.sendMessage(state.tabId, payload);
  } catch {
    /* content script not injected (e.g. page loaded before install) */
  }
}

function broadcastToPopup(payload) {
  chrome.runtime.sendMessage({ from: "background", type: "popup-event", payload }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.from === "background") return false;

  handleMessage(message, _sender)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
  return true;
});

/** Runs in the PAGE context (world: MAIN) to inspect React props and the
 *  network resources of the player's transcript. Serialised by executeScript,
 *  so it must not reference anything outside its own body. */
function pageProbe() {
  const out = { resources: [], reactKeys: [], propKeys: [], props: "", fibers: [] };
  try {
    out.resources = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => /transcript|caption|subtitle|vtt|srt/i.test(name))
      .slice(0, 25);
  } catch (error) {
    /* ignore */
  }
  const el = document.querySelector('[data-purpose="transcript-cue"]');
  if (!el) return out;
  const keys = Object.keys(el).filter((key) => key.startsWith("__react"));
  out.reactKeys = keys;
  const propKey = keys.find((key) => key.startsWith("__reactProps$"));
  const fiberKey = keys.find((key) => key.startsWith("__reactFiber$"));
  if (propKey) {
    try {
      out.propKeys = Object.keys(el[propKey]).slice(0, 25);
      out.props = JSON.stringify(el[propKey]).slice(0, 600);
    } catch (error) {
      out.props = "unserialisable";
    }
  }
  if (fiberKey) {
    let fiber = el[fiberKey];
    let depth = 0;
    while (fiber && depth < 8) {
      try {
        const props = fiber.memoizedProps;
        if (props) {
          const text = JSON.stringify(props);
          if (text && text.length > 30) out.fibers.push(String(text).slice(0, 500));
        }
      } catch (error) {
        /* circular */
      }
      fiber = fiber.return;
      depth += 1;
    }
    out.fibers = out.fibers.slice(0, 4);
  }
  return out;
}

async function serverLog(event) {
  try {
    await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      type: "http",
      method: "POST",
      path: "/client-log",
      body: { event },
      timeout: 20,
    });
  } catch {
    /* diagnostics only */
  }
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case "start":
      return start(message);
    case "stop":
      return stop();
    case "get-status":
      return getStatus();
    case "server-info":
      return getServerInfo(Boolean(message.force));
    case "set-config":
      return { config: await setConfig(message.config || {}) };
    case "translate-cues": {
      const cues = Array.isArray(message.cues) ? message.cues : [];
      if (!cues.length) return { translations: [] };
      try {
        const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
          type: "http",
          method: "POST",
          path: "/translate-cues",
          body: { cues, lesson: message.lesson || null },
          timeout: 300,
        });
        if (!response) return { error: "bridge không phản hồi" };
        if (response.status === 0) return { error: response.error || "bridge lỗi" };
        if (response.status !== 200) {
          return { error: (response.body && response.body.detail) || `HTTP ${response.status}` };
        }
        return { translations: (response.body && response.body.translations) || [] };
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) };
      }
    }
    case "client-debug":
      serverLog({ kind: "debug", data: message.data || null });
      return { ok: true };

    case "transcript-status":
      broadcastToPopup({ type: "transcript-status", text: message.text, state: message.state });
      return { ok: true };

    case "probe-transcript": {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      if (tabId === undefined || tabId === null) return { error: "no sender tab" };
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: pageProbe,
        });
        const probe = result ? result.result : null;
        serverLog({ kind: "probe", url: sender.tab.url, probe });
        return { probe };
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) };
      }
    }
    case "replay":
      log("background", "replay requested", { id: message.id });
      return offscreenMessage({ type: "offscreen-replay", id: message.id });
    case "interrupt":
      return offscreenMessage({ type: "offscreen-interrupt" });

    case "get-log":
      return { entries: logs.slice(-LOG_LIMIT) };
    case "clear-log":
      logs = [];
      await chrome.storage.session.set({ debugLog: [] });
      return { ok: true };

    case "get-transcript":
      return { rows: utterances.slice() };
    case "clear-transcript":
      utterances = [];
      await chrome.storage.session.set({ utterances: [] });
      chrome.runtime.sendMessage({ from: "background", type: "transcript-cleared" }).catch(() => {});
      return { ok: true };
    case "open-transcript":
      await chrome.tabs.create({ url: chrome.runtime.getURL("src/transcript.html") });
      return { ok: true };

    case "offscreen-log":
      log(message.scope || "offscreen", message.message, message.extra ?? null);
      return { ok: true };

    case "bridge-open":
      return { ok: ensureNativePort() };

    case "bridge-close":
      closeNativePort();
      return { ok: true };

    case "bridge-send":
      if (!ensureNativePort() || !nativePort) {
        log("error", "bridge-send dropped: native port unavailable");
        return { ok: false };
      }
      try {
        nativePort.postMessage(message.payload);
      } catch (error) {
        log("error", `native port post failed: ${error && error.message ? error.message : error}`);
      }
      return { ok: true };

    case "offscreen-status":
      state.server = message.status;
      log("status", `${message.status.state}${message.status.detail ? " — " + message.status.detail : ""}`,
        message.status.latency_ms ? { latency_ms: message.status.latency_ms } : null);
      broadcastToPopup({ type: "status", ...message.status });
      await forwardToTab({ type: "status", ...message.status });
      return { ok: true };

    case "offscreen-event": {
      const payload = message.payload || {};
      if (payload.type === "asr" || payload.type === "translation" || payload.type === "error") {
        log("pipeline", `${payload.type} ${payload.id ?? ""}`, {
          text: payload.text ? payload.text.slice(0, 120) : undefined,
          state: payload.state,
          total_ms: payload.total_ms,
          error: payload.message,
        });
      }
      recordEvent(payload);
      await forwardToTab(payload);
      broadcastToPopup(payload);
      return { ok: true };
    }

    case "offscreen-error":
      log("error", message.message);
      state.server = { state: "error", detail: message.message };
      broadcastToPopup({ type: "status", state: "error", detail: message.message });
      await forwardToTab({ type: "status", state: "error", detail: message.message });
      return { ok: true };

    case "capture-ended":
      log("background", "capture ended by page/stream");
      state.running = false;
      state.tabId = null;
      closeNativePort();
      await persist();
      await updateBadge();
      return { ok: true };

    default:
      return { ok: false, error: `unknown message: ${message.type}` };
  }
}

// Keyboard fallback: a command invocation also grants activeTab, so this works
// even if the popup path is blocked by the browser.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-capture") return;
  log("background", "command toggle-capture");
  try {
    if (state.running) await stop();
    else await start({});
  } catch (error) {
    log("error", `command failed: ${error && error.message ? error.message : error}`);
    state.server = { state: "error", detail: String(error && error.message ? error.message : error) };
    broadcastToPopup({ type: "status", state: "error", detail: state.server.detail });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  Promise.all([restoreState(), restoreLog()]).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  Promise.all([restoreState(), restoreLog()]).catch(() => {});
});

Promise.all([restoreState(), restoreLog()]).catch(() => {});
