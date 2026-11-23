/**
 * Service worker: bridges the popup/content script to the local translation
 * server through the native-messaging host (Chrome blocks extension pages
 * from fetching loopback URLs). Transcript mode only — no tab capture.
 */

const NATIVE_HOST = "com.speechtrans.bridge";
const INFO_TTL_MS = 5000;

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

async function restoreSettings() {
  const stored = await chrome.storage.local.get("captions");
  if (typeof stored.captions === "boolean") captions = stored.captions;
}

async function setCaptions(value) {
  captions = value !== false;
  await chrome.storage.local.set({ captions });
  const tabs = await chrome.tabs.query({ url: "https://*.udemy.com/*" });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    chrome.tabs.sendMessage(tab.id, { type: "set-captions", captions }).catch(() => {});
  }
  return captions;
}

// --- server health -----------------------------------------------------
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

function broadcastToPopup(payload) {
  chrome.runtime.sendMessage({ from: "background", type: "popup-event", payload }).catch(() => {});
}

async function translateCues(cues, lesson) {
  try {
    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      type: "http",
      method: "POST",
      path: "/translate-cues",
      body: { cues, lesson: lesson || null },
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
      return { captions };

    case "set-config":
      return { config: { captions: await setCaptions((message.config || {}).captions) } };

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
