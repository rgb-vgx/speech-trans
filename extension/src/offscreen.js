/**
 * Offscreen audio engine (subtitles only).
 *
 *  - capture the Udemy tab's audio (stream id minted by the popup)
 *  - keep the lecture audible: tabCapture removes the audio from normal output,
 *    so the captured stream is routed back to the speakers at full volume
 *  - downsample to 16 kHz mono PCM in 100 ms frames and send it to the local
 *    server through the native-messaging bridge (Chrome blocks loopback
 *    sockets from extension pages)
 *
 * No audio is played back here; translation arrives as text events.
 */

const NATIVE_HOST = "com.speechtrans.bridge";

let ctx = null;
let mediaStream = null;
let sourceNode = null;
let captureGain = null;
let workletNode = null;
let silentGain = null;

let bridgeOpen = false;
let reconnectTimer = null;
let reconnectDelay = 1000;
let pingTimer = null;
let running = false;
let activeTabId = null;

let config = { captions: true };

let pcmFrames = 0;
let pcmWindowStart = 0;
let pcmWindowCount = 0;
let statsTimer = null;
let lastBridgeMessageAt = 0;

function postBackground(message) {
  chrome.runtime.sendMessage({ from: "offscreen", ...message }).catch(() => {});
}

function log(message, extra = null, scope = "offscreen") {
  console.log(`[st:${scope}] ${message}`, extra ?? "");
  postBackground({ type: "offscreen-log", scope, message, extra });
}

function reportStatus(status) {
  postBackground({ type: "offscreen-status", status });
}

function reportError(message) {
  console.warn("[speech-trans]", message);
  postBackground({ type: "offscreen-error", message });
}

function forwardEvent(payload) {
  postBackground({ type: "offscreen-event", payload });
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function startCapture(streamId, tabId) {
  if (running) await stopCapture({ notify: false });
  running = true;
  activeTabId = tabId;
  pcmFrames = 0;
  pcmWindowStart = 0;
  pcmWindowCount = 0;
  lastBridgeMessageAt = Date.now();
  log("startCapture: requesting tab audio", { tabId, streamIdPrefix: String(streamId).slice(0, 12) });

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch (error) {
    log("getUserMedia(tab) FAILED", String(error), "error");
    throw error;
  }

  const track = mediaStream.getAudioTracks()[0];
  log("tab audio captured", {
    tracks: mediaStream.getAudioTracks().length,
    label: track && track.label,
    muted: track && track.muted,
  });
  track.addEventListener("ended", () => {
    log("tab audio track ended");
    postBackground({ type: "capture-ended" });
    stopCapture({ notify: false }).catch(() => {});
  });

  ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.resume().catch(() => {});
  log("AudioContext", { state: ctx.state, sampleRate: ctx.sampleRate });

  sourceNode = ctx.createMediaStreamSource(mediaStream);

  // tabCapture takes the audio away from normal output: route it back so the
  // lecture stays audible.
  captureGain = ctx.createGain();
  captureGain.gain.value = 1;
  sourceNode.connect(captureGain).connect(ctx.destination);

  await ctx.audioWorklet.addModule(chrome.runtime.getURL("src/resampler-worklet.js"));
  workletNode = new AudioWorkletNode(ctx, "pcm16-resampler");
  workletNode.port.onmessage = (event) => {
    ensureAudioRunning();
    sendPcm(event.data);
  };
  sourceNode.connect(workletNode);
  // A node with no path to the destination may be skipped by the graph;
  // connect it through a muted gain to guarantee processing.
  silentGain = ctx.createGain();
  silentGain.gain.value = 0;
  workletNode.connect(silentGain).connect(ctx.destination);
  log("worklet loaded, capture graph ready");

  connectBridge();
  reportStatus({ state: "capturing", detail: "Đang thu âm thanh tab" });
}

async function stopCapture({ notify = true } = {}) {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;

  if (bridgeOpen) postBackground({ type: "bridge-close" });
  bridgeOpen = false;

  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (captureGain) {
    captureGain.disconnect();
    captureGain = null;
  }
  if (silentGain) {
    silentGain.disconnect();
    silentGain = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (ctx) {
    await ctx.close().catch(() => {});
    ctx = null;
  }
  activeTabId = null;
  if (notify) reportStatus({ state: "idle", detail: "Đã dừng" });
}

// ---------------------------------------------------------------------------
// Uplink: native bridge (owned by the service worker)
// ---------------------------------------------------------------------------

// Offscreen documents do not expose chrome.runtime.connectNative, so the
// service worker owns the native port and we relay through it.
function connectBridge() {
  if (!running) return;
  clearTimeout(reconnectTimer);
  log("asking service worker to open native bridge", { host: NATIVE_HOST });
  postBackground({ type: "bridge-open" });
}

function onBridgeDisconnect(detail) {
  log("bridge disconnected", detail || "no detail", "error");
  bridgeOpen = false;
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  if (!running) return;
  reportStatus({
    state: "disconnected",
    detail: detail ? `Bridge dừng: ${detail}` : "Bridge dừng, đang thử lại…",
  });
  reconnectTimer = setTimeout(connectBridge, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
}

function sendJson(payload) {
  if (!bridgeOpen) return;
  postBackground({ type: "bridge-send", payload });
}

/** Offscreen documents have no user gesture; if Chrome left the context
 *  suspended, nothing is captured, so nudge it back to "running". */
function ensureAudioRunning() {
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

/** The audio graph normally produces 10 frames/s (100 ms each). If Chrome has
 *  no working output device it can free-run several times faster, which floods
 *  the server; drop the excess. */
function paceAudio() {
  const now = performance.now();
  if (now - pcmWindowStart > 1000) {
    if (pcmWindowCount > 20) {
      log(`audio engine is running ${(pcmWindowCount / 10).toFixed(1)}x realtime`, {
        framesPerSecond: pcmWindowCount,
      }, "error");
      reportError(
        `Âm thanh chạy ${(pcmWindowCount / 10).toFixed(1)}x thời gian thực — pipeline sẽ bị lệch. ` +
          "Thử khởi động lại Chrome; nếu vẫn vậy gửi tôi nhật ký debug."
      );
    }
    pcmWindowStart = now;
    pcmWindowCount = 0;
  }
  pcmWindowCount += 1;
  return pcmWindowCount <= 14;
}

function sendPcm(arrayBuffer) {
  if (!bridgeOpen) {
    if (pcmFrames === 0) log("dropping PCM: bridge not connected", null, "error");
    return;
  }
  if (!paceAudio()) return;
  const pcm = new Int16Array(arrayBuffer);
  pcmFrames += 1;
  if (pcmFrames === 1 || pcmFrames % 100 === 0) {
    log("PCM sent", { frames: pcmFrames, bytes: pcm.byteLength });
  }
  sendJson({ type: "audio", data: int16ToBase64(pcm) });
}

function int16ToBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Downlink: events
// ---------------------------------------------------------------------------

function handleBridgeMessage(message) {
  if (!message || !message.type) return;
  lastBridgeMessageAt = Date.now();
  if (message.type !== "event") return; // no server audio any more
  const payload = message.payload || {};
  if (payload.type === "status" && payload.state === "bridge-connected") {
    log("bridge connected");
    bridgeOpen = true;
    reconnectDelay = 1000;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => sendJson({ type: "ping", t: performance.now() }), 5000);
    reportStatus({ state: "connected", detail: "Đã kết nối server" });
    return;
  }
  if (payload.type === "status") log("server status", payload);
  handleServerEvent(payload);
}

function handleServerEvent(event) {
  if (!event || !event.type) return;
  switch (event.type) {
    case "config":
      log("server config", { input_sample_rate: event.input_sample_rate });
      break;
    case "asr":
    case "translation":
    case "error":
    case "status":
      forwardEvent(event);
      break;
    case "pong":
      reportStatus({ state: "connected", latency_ms: Math.round(performance.now() - event.t) });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Watchdog + messages from the service worker
// ---------------------------------------------------------------------------

/** Every 5 s: reopen the bridge if the service worker was restarted under us. */
function watchdogTick() {
  if (!running) return;
  if (!bridgeOpen) {
    log("watchdog: bridge is down, reopening", null, "error");
    connectBridge();
  } else if (lastBridgeMessageAt && Date.now() - lastBridgeMessageAt > 25000) {
    log("watchdog: bridge silent for 25s", { last_message_ms_ago: Date.now() - lastBridgeMessageAt }, "error");
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.from !== "background") return false;

  switch (message.type) {
    case "offscreen-start":
      applyConfig(message.config || {});
      startCapture(message.streamId, message.tabId)
        .then(() => {
          if (statsTimer) clearInterval(statsTimer);
          statsTimer = setInterval(watchdogTick, 5000);
          sendResponse({ ok: true });
        })
        .catch((error) => {
          running = false;
          reportError(String(error && error.message ? error.message : error));
          sendResponse({ error: String(error && error.message ? error.message : error) });
        });
      return true;

    case "offscreen-stop":
      stopCapture()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ error: String(error) }));
      return true;

    case "offscreen-config":
      applyConfig(message.config || {});
      sendResponse({ ok: true });
      return false;

    case "bridge-message":
      handleBridgeMessage(message.message);
      return false;

    case "bridge-disconnected":
      onBridgeDisconnect(message.detail);
      return false;

    default:
      return false;
  }
});

function applyConfig(patch) {
  config = { ...config, ...patch };
  log("config applied", { captions: config.captions });
}
