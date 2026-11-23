/**
 * Service worker: bridges the popup/content script to the local translation
 * server through the native-messaging host (Chrome blocks extension pages
 * from fetching loopback URLs). Transcript mode only — no tab capture.
 */

const NATIVE_HOST = "com.speechtrans.bridge";
const INFO_TTL_MS = 5000;
const SERVER_BASE = "http://127.0.0.1:8787";
// Chrome/Edge block extension pages from fetching loopback URLs, so they go
// through the native-messaging bridge. Firefox allows a direct fetch when the
// manifest has the host permission — no extra installer needed.
const IS_FIREFOX = chrome.runtime.getURL("").startsWith("moz-extension://");

async function serverRequest(path, { method = "GET", body = null, timeout = 180 } = {}) {
  if (!IS_FIREFOX) {
    const message = { type: "http", method, path, timeout };
    if (body !== null) message.body = body;
    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST, message);
    if (!response) return { status: 0, error: "bridge không phản hồi" };
    return response;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const response = await fetch(`${SERVER_BASE}${path}`, {
      method,
      headers: body !== null ? { "Content-Type": "application/json" } : undefined,
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, body: payload };
  } catch (error) {
    return { status: 0, error: String(error && error.message ? error.message : error) };
  } finally {
    clearTimeout(timer);
  }
}

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
  const { debugLog } = await chrome.storage.session.get("debugLog");
  if (Array.isArray(debugLog)) logs = debugLog.slice(-LOG_LIMIT);
}

// --- settings ----------------------------------------------------------
let captions = true;
let cueOffset = 0;
let captionBottom = 13;
let hideNative = false;
let hideEnglish = false;

async function restoreSettings() {
  const stored = await chrome.storage.local.get([
    "captions",
    "cueOffset",
    "captionBottom",
    "hideNative",
    "hideEnglish",
  ]);
  if (typeof stored.captions === "boolean") captions = stored.captions;
  if (Number.isFinite(stored.cueOffset)) cueOffset = clampOffset(stored.cueOffset);
  if (Number.isFinite(stored.captionBottom)) captionBottom = clampBottom(stored.captionBottom);
  if (typeof stored.hideNative === "boolean") hideNative = stored.hideNative;
  if (typeof stored.hideEnglish === "boolean") hideEnglish = stored.hideEnglish;
}

function clampOffset(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-15, Math.min(15, Math.round(number * 4) / 4));
}

/** Percent of the video height, measured from the bottom edge. */
function clampBottom(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 13;
  return Math.max(2, Math.min(50, Math.round(number)));
}

async function broadcastConfig() {
  const tabs = await chrome.tabs.query({ url: "https://*.udemy.com/*" });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    chrome.tabs
      .sendMessage(tab.id, {
        type: "ui-config",
        captions,
        offset: cueOffset,
        bottom: captionBottom,
        hideNative,
        hideEnglish,
      })
      .catch(() => {});
  }
}

async function setConfig(patch) {
  if (typeof patch.captions === "boolean") captions = patch.captions;
  if (patch.cueOffset !== undefined) cueOffset = clampOffset(patch.cueOffset);
  if (patch.captionBottom !== undefined) captionBottom = clampBottom(patch.captionBottom);
  if (typeof patch.hideNative === "boolean") hideNative = patch.hideNative;
  if (typeof patch.hideEnglish === "boolean") hideEnglish = patch.hideEnglish;
  await chrome.storage.local.set({ captions, cueOffset, captionBottom, hideNative, hideEnglish });
  await broadcastConfig();
  return { captions, cueOffset, captionBottom, hideNative, hideEnglish };
}

// --- server health -----------------------------------------------------
let infoCache = { at: 0, value: null, inflight: null };

async function getServerInfo(force = false) {
  if (!force && infoCache.value && Date.now() - infoCache.at < INFO_TTL_MS) return infoCache.value;
  if (infoCache.inflight) return infoCache.inflight;
  infoCache.inflight = (async () => {
    try {
      let value;
      if (IS_FIREFOX) {
        const response = await serverRequest("/health", { timeout: 5 });
        value =
          response.status === 200
            ? { type: "info", health: response.body }
            : { error: response.error || `HTTP ${response.status}` };
      } else {
        value = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "info" });
      }
      infoCache = { at: Date.now(), value, inflight: null };
      return value;
    } catch (error) {
      const value = { error: String(error && error.message ? error.message : error) };
      infoCache = { at: Date.now(), value, inflight: null };
      return value;
    }
  })();
  return infoCache.inflight;
}

async function serverLog(event) {
  try {
    await serverRequest("/client-log", { method: "POST", body: { event }, timeout: 20 });
  } catch {
    /* diagnostics only */
  }
}

function broadcastToPopup(payload) {
  chrome.runtime.sendMessage({ from: "background", type: "popup-event", payload }).catch(() => {});
}

async function translateCues(cues, lesson) {
  try {
    const response = await serverRequest("/translate-cues", {
      method: "POST",
      body: { cues, lesson: lesson || null },
      timeout: 300,
    });
    if (!response) return { error: "bridge không phản hồi" };
    if (response.status === 0) {
      const message = String(response.error || "");
      if (/refused|urlopen|connection/i.test(message)) {
        return { error: "Server chưa chạy — mở terminal: cd server && uv run python -m app.main" };
      }
      return { error: message || "bridge lỗi" };
    }
    if (response.status !== 200) {
      return { error: (response.body && response.body.detail) || `HTTP ${response.status}` };
    }
    return { translations: (response.body && response.body.translations) || [] };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
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

async function handleMessage(message, sender) {
  switch (message.type) {
    case "server-info":
      return getServerInfo(Boolean(message.force));

    case "translate-cues": {
      const cues = Array.isArray(message.cues) ? message.cues : [];
      if (!cues.length) return { translations: [] };
      return translateCues(cues, message.lesson);
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

    case "get-config":
      return { captions, cueOffset, captionBottom, hideNative, hideEnglish };

    case "set-config":
      return { config: await setConfig(message.config || {}) };

    case "get-log":
      return { entries: logs.slice(-LOG_LIMIT) };

    case "clear-log":
      logs = [];
      await chrome.storage.session.set({ debugLog: [] });
      return { ok: true };

    default:
      return { ok: false, error: `unknown message: ${message.type}` };
  }
}

function restoreAll() {
  Promise.all([restoreSettings(), restoreLog()]).catch(() => {});
}

chrome.runtime.onInstalled.addListener(restoreAll);
chrome.runtime.onStartup.addListener(restoreAll);
restoreAll();
