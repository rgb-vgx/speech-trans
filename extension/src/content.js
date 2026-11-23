/**
 * Subtitle overlay for Udemy. Rendered inside a shadow root so Udemy's CSS
 * cannot leak in, and re-parented into the fullscreen element when the player
 * goes fullscreen.
 */
(() => {
  if (window.__speechTransLoaded) return;
  window.__speechTransLoaded = true;

  let host = null;
  let shadow = null;
  let els = null;
  let captionsEnabled = true;
  let cueOffset = 0;
  let captionBottom = 13;
  let hideNative = false;
  let hideEnglish = false;
  let loadToken = 0;

  function buildHost() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = "speech-trans-root";
    host.style.cssText =
      "position:fixed;inset:0;z-index:2147483000;pointer-events:none;display:block;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          position: fixed; left: 0; top: 0; width: min(1080px, 86vw);
          display: flex; flex-direction: column; gap: 6px; align-items: center;
          font-family: "Inter", "Roboto", system-ui, -apple-system, sans-serif;
          pointer-events: none; opacity: 0; transition: opacity .2s ease;
        }
        .wrap.show { opacity: 1; }
        .wrap.quiet .bar { opacity: 0; transition: opacity .3s ease; }
        .wrap.quiet .bar:hover { opacity: 1; }
        .line {
          text-align: center; padding: 9px 16px; border-radius: 12px;
          background: rgba(8, 11, 16, .82); color: #fff;
          box-shadow: 0 6px 24px rgba(0,0,0,.35);
          text-shadow: 0 1px 2px rgba(0,0,0,.55);
          max-width: 100%; box-sizing: border-box;
        }
        .en { font-size: 15px; line-height: 1.35; color: #b8c4d6; font-weight: 400;
              display: none; }
        .vi { font-size: 21px; line-height: 1.4; font-weight: 600;
              display: none; }
        .bar {
          display: flex; align-items: center; gap: 12px; margin-top: 2px;
          pointer-events: auto;
        }
        .meta { display: flex; align-items: center; gap: 8px;
                font-size: 11px; color: #93a3ba; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #f59e0b;
               box-shadow: 0 0 0 3px rgba(245,158,11,.15); }
        .dot.ok { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.15); }
        .dot.err { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.15); }
        button {
          all: unset; cursor: pointer; pointer-events: auto;
          font-size: 11px; color: #cbd5e1; padding: 4px 10px;
          border: 1px solid rgba(255,255,255,.14); border-radius: 999px;
          background: rgba(15,20,28,.7);
        }
        button:hover { background: rgba(37,99,235,.35); color: #fff; }
        button:active { transform: translateY(1px); }
      </style>
      <div class="wrap" id="wrap">
        <div class="line en" id="en"></div>
        <div class="line vi" id="vi"></div>
        <div class="bar">
          <span class="meta">
            <span class="dot" id="dot"></span>
            <span id="status">SpeechTrans</span>
          </span>
        </div>
      </div>
    `;
    els = {
      wrap: shadow.getElementById("wrap"),
      en: shadow.getElementById("en"),
      vi: shadow.getElementById("vi"),
      dot: shadow.getElementById("dot"),
      status: shadow.getElementById("status"),
    };
    mount();
  }

  function mount() {
    const target =
      document.fullscreenElement && document.fullscreenElement.tagName !== "VIDEO"
        ? document.fullscreenElement
        : document.body;
    if (!target || !host) return;
    if (host.parentNode !== target) target.appendChild(host);
    // Fullscreen containers may be transformed; fixed positioning still works
    // because the host is a direct child of the fullscreen element.
  }

  /** Anchor the subtitle box to the video element (not the page bottom): Udemy
   *  puts the player near the top of the page, so bottom:88px landed below it. */
  function positionOverlay() {
    if (!els || !host || !host.isConnected) return;
    const video = videoElement();
    if (!video) return;
    const rect = video.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 100) return;
    const width = Math.min(1100, rect.width * 0.92);
    // Anchor the box to the BOTTOM edge of the video, 72 px up so it sits just
    // above the player's control bar — i.e. it looks embedded in the video.
    const boxHeight = els.wrap.offsetHeight || 110;
    // captionBottom is a percentage of the video height measured from its
    // bottom edge (popup → "Vị trí phụ đề"), clamped so the box stays on top.
    const percent = Math.max(2, Math.min(50, captionBottom));
    const bottomGap = Math.max(12, Math.min(rect.height * 0.6, (rect.height * percent) / 100));
    const top = rect.top + rect.height - bottomGap - boxHeight;
    els.wrap.style.position = "fixed";
    els.wrap.style.left = `${Math.max(8, rect.left + (rect.width - width) / 2)}px`;
    els.wrap.style.top = `${Math.max(rect.top + 8, top)}px`;
    els.wrap.style.width = `${width}px`;
    els.wrap.style.bottom = "auto";
    els.wrap.style.transform = "none";
  }

  function startPositionLoop() {
    if (startPositionLoop.timer) return;
    startPositionLoop.timer = setInterval(positionOverlay, 500);
  }

  function setLine(el, text) {
    if (!el) return;
    const clean = (text || "").trim();
    el.textContent = clean;
    el.style.display = clean ? "block" : "none";
  }

  function renderCurrentCue() {
    if (!els) return;
    const cue = transcript.cues[transcript.index];
    if (!cue) return;
    setLine(els.en, hideEnglish ? "" : cue.en);
    setLine(els.vi, cue.vi);
  }

  // Hide Udemy's own captions while keeping the text tracks readable for the
  // transcript extractor: CSS only, no track.mode changes.
  const NATIVE_CAPTION_SELECTORS = [
    ".vjs-text-track-display",
    ".shaka-text-container",
    '[data-purpose="captions-display"]',
    '[data-purpose="captions-container"]',
    '[data-purpose="captions-cue-display"]',
    '[class*="captions-container"]',
    '[class*="captions--container"]',
    '[class*="captions-display"]',
    '[class*="captions--display"]',
    '[class*="captions-cue"]',
    '[class*="captions--cue"]',
    '[class*="caption-window"]',
    '[class*="captions-window"]',
    '[class*="subtitles-container"]',
    '[class*="subtitles--container"]',
    '[class*="subtitles-display"]',
  ].join(",");

  function applyNativeCaptionStyle() {
    let style = document.getElementById("speech-trans-hide-native");
    if (!hideNative) {
      if (style) style.remove();
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.id = "speech-trans-hide-native";
      style.textContent = [
        "video::cue { visibility: hidden !important; opacity: 0 !important; }",
        `${NATIVE_CAPTION_SELECTORS} { display: none !important; }`,
      ].join("\n");
      (document.head || document.documentElement).appendChild(style);
      let matches = 0;
      try {
        matches = document.querySelectorAll(NATIVE_CAPTION_SELECTORS).length;
      } catch {
        /* ignore */
      }
      dbg({ step: "hide-native", matches });
    }
  }

  function setStatus(state, detail) {
    if (!els) return;
    if (state === "error" && els.wrap) els.wrap.classList.remove("quiet");
    const dot = els.dot;
    dot.classList.remove("ok", "err");
    if (state === "connected" || state === "ready") dot.classList.add("ok");
    else if (state === "error" || state === "disconnected" || state === "offline") dot.classList.add("err");
    els.status.textContent = detail || defaultStatusLabel(state);
  }

  function defaultStatusLabel(state) {
    switch (state) {
      case "connected":
        return "Đang dịch";
      case "disconnected":
        return "Mất kết nối server";
      case "error":
        return "Lỗi";
      default:
        return "SpeechTrans";
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.type === "transcript-load") {
      loadTranscript().catch((error) => transcriptStatus(String(error && error.message ? error.message : error), "error"));
      return false;
    }
    if (message.type === "transcript-clear") {
      clearTranscript();
      return false;
    }
    if (message.type === "transcript-state") {
      sendResponse({
        enabled: transcript.enabled,
        cues: transcript.cues.length,
        index: transcript.index,
        active: transcript.enabled && transcript.cues.length > 0,
      });
      return true;
    }
    if (message.type === "set-captions" || message.type === "ui-config") {
      if (typeof message.captions === "boolean") captionsEnabled = message.captions;
      if (Number.isFinite(message.offset)) cueOffset = message.offset;
      if (Number.isFinite(message.bottom)) captionBottom = message.bottom;
      if (typeof message.hideNative === "boolean") {
        hideNative = message.hideNative;
        applyNativeCaptionStyle();
      }
      if (typeof message.hideEnglish === "boolean") {
        hideEnglish = message.hideEnglish;
        renderCurrentCue();
      }
      if (els) positionOverlay();
      if (!captionsEnabled && els) els.wrap.classList.remove("show");
      return false;
    }
    if (message.type === "transcript-debug") {
      chrome.runtime
        .sendMessage({ from: "content", type: "transcript-status", text: JSON.stringify(transcriptDebug()).slice(0, 900) })
        .catch(() => {});
      return false;
    }
    return false;
  });

  // ---------------------------------------------------------------------
  // Transcript mode: pre-translated cues shown against video.currentTime
  // ---------------------------------------------------------------------
  const transcript = { cues: [], index: -1, enabled: false, loading: false, key: "", timer: null };

  function lessonKey() {
    return location.origin + location.pathname;
  }

  function dbg(data) {
    chrome.runtime
      .sendMessage({ from: "content", type: "client-debug", data: { ...(data || {}), href: location.href } })
      .catch(() => {});
  }

  function transcriptStatus(text, state = "info") {
    setStatus(state === "error" ? "error" : "connected", text);
    chrome.runtime
      .sendMessage({ from: "content", type: "transcript-status", text, state })
      .catch(() => {});
  }

  function parseTimestamp(raw) {
    const match = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(raw || "");
    if (!match) return null;
    const a = Number(match[1]);
    const b = Number(match[2]);
    const c = match[3] === undefined ? null : Number(match[3]);
    return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  }

  function cuesFromTextTracks() {
    const video = document.querySelector("video");
    if (!video || !video.textTracks) return [];
    const out = [];
    for (const track of video.textTracks) {
      try {
        const cues = track.cues;
        if (!cues) continue;
        for (const cue of cues) {
          const text = (cue.text || "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (!text) continue;
          out.push({ start: cue.startTime, end: cue.endTime, text });
        }
      } catch (error) {
        // cross-origin tracks can deny cue access
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  function cueStart(node) {
    for (const attr of ["data-start-time", "data-start", "data-time", "data-timestamp", "data-offset"]) {
      const raw = node.getAttribute(attr);
      if (raw === null || raw === "") continue;
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) return numeric > 100000 ? numeric / 1000 : numeric;
      const parsed = parseTimestamp(raw);
      if (parsed !== null) return parsed;
    }
    const stamp =
      node.querySelector('[data-purpose*="timestamp"]') ||
      node.querySelector('[class*="timestamp"]') ||
      node.querySelector("time");
    if (stamp) {
      const parsed = parseTimestamp(stamp.textContent);
      if (parsed !== null) return parsed;
    }
    return parseTimestamp(node.textContent);
  }

  function cueText(node, startSeconds) {
    let text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    const stamp = node.querySelector('[data-purpose*="timestamp"], [class*="timestamp"], time');
    if (stamp && stamp.textContent) text = text.replace(stamp.textContent.trim(), " ");
    // strip a leading "0:12" left in the text
    text = text.replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\s*/, "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text;
  }

  function scrapeTranscript() {
    const selectors = [
      '[data-purpose="transcript-cue"]',
      '[class*="transcript"] [class*="cue"]',
      '[data-purpose="transcript-panel"] li',
      '[data-purpose*="transcript"] [role="button"]',
    ];
    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)];
      if (!nodes.length) continue;
      const cues = [];
      for (const node of nodes) {
        const start = cueStart(node);
        if (start === null) continue;
        const text = cueText(node, start);
        if (!text) continue;
        if (cues.length && start <= cues[cues.length - 1].start) continue;
        cues.push({ start, text });
      }
      if (cues.length) return cues;
    }
    return [];
  }

  function waitForSeek(video, timeoutMs) {
    return new Promise((resolve) => {
      const before = video.currentTime;
      const started = performance.now();
      const tick = () => {
        if (Math.abs(video.currentTime - before) > 0.01 || performance.now() - started > timeoutMs) {
          resolve(video.currentTime);
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  }

  /** Udemy's transcript panel has no timestamps in the DOM (some versions):
   *  click each cue, which seeks the player, and read video.currentTime.
   *  Restores the original time and play state afterwards. */
  async function scrapeTranscriptBySeeking() {
    const nodes = [...document.querySelectorAll('[data-purpose="transcript-cue"]')];
    const video = document.querySelector("video");
    if (!nodes.length || !video || !Number.isFinite(video.duration) || video.duration <= 0) return [];

    const originalTime = video.currentTime;
    const wasPaused = video.paused;
    video.pause();
    transcriptStatus(`Đang đo thời gian ${nodes.length} câu (video sẽ tua nhanh)…`);

    const starts = [];
    for (let index = 0; index < nodes.length; index += 1) {
      nodes[index].click();
      starts.push(await waitForSeek(video, 500));
      if (index % 25 === 0) transcriptStatus(`Đang đo ${index}/${nodes.length} câu…`);
      if (!video.paused) video.pause();
    }
    video.pause();
    video.currentTime = originalTime;
    if (!wasPaused) video.play().catch(() => {});

    const cues = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const text = cueText(nodes[index]);
      const start = starts[index];
      if (!text || !Number.isFinite(start)) continue;
      if (cues.length && start <= cues[cues.length - 1].start) continue;
      cues.push({ start, end: start + 4, text });
    }
    return cues;
  }

  /** Diagnostics for the popup when scraping fails. */
  function transcriptDebug() {
    const container = transcriptContainer();
    const node = document.querySelector('[data-purpose="transcript-cue"]') ||
      document.querySelector('[class*="transcript"] [class*="cue"]') ||
      (container && container.firstElementChild);
    if (!node) return { count: 0, sample: "", attrs: [], container: null };
    return {
      count: document.querySelectorAll('[data-purpose="transcript-cue"]').length,
      sample: node.outerHTML.replace(/\s+/g, " ").slice(0, 350),
      attrs: [...node.attributes].map((a) => `${a.name}=${a.value}`).slice(0, 10),
      container: container
        ? `${container.tagName}.${(container.className || "").toString().slice(0, 60)} children=${container.children.length}`
        : null,
    };
  }

  function openTranscriptPanel() {
    // Never click the toggle when the panel is already rendered: it is a
    // toggle, so a second click closes it again.
    if (transcriptContainer()) return true;
    const toggle = document.querySelector('[data-purpose="transcript-toggle"]');
    if (toggle) {
      toggle.click();
      return true;
    }
    return false;
  }

  async function requestProbe() {
    try {
      const response = await chrome.runtime.sendMessage({ from: "content", type: "probe-transcript" });
      return response && response.probe ? response.probe : null;
    } catch {
      return null;
    }
  }

  function captionVttUrl(probe) {
    const resources = (probe && probe.resources) || [];
    return resources.find((url) => /\.vtt(\?|$)/i.test(url) && !/thumb/i.test(url)) || null;
  }

  function parseVtt(text) {
    const cues = [];
    const blocks = text.replace(/\r/g, "").split(/\n\s*\n/);
    // Udemy VTT uses MM:SS.mmm (no hours); accept HH:MM:SS too.
    const timing =
      /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
    for (const block of blocks) {
      const lines = block.split("\n").filter((line) => line.trim());
      if (!lines.length) continue;
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) continue;
      const match = timing.exec(lines[timingIndex]);
      if (!match) continue;
      const sec = (h, m, s, ms) =>
        (h === undefined ? 0 : Number(h) * 3600) + Number(m) * 60 + Number(s) + Number(ms) / 1000;
      const start = sec(match[1], match[2], match[3], match[4]);
      const end = sec(match[5], match[6], match[7], match[8]);
      const cueText = lines
        .slice(timingIndex + 1)
        .join(" ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (cueText) cues.push({ start, end, text: cueText });
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  async function cuesFromVttUrl(url) {
    if (!url) return [];
    try {
      const response = await fetch(url, { credentials: "omit" });
      dbg({ step: "vtt-fetch", ok: response.ok, status: response.status });
      if (!response.ok) return [];
      const text = await response.text();
      const cues = parseVtt(text);
      dbg({ step: "vtt-parsed", bytes: text.length, cues: cues.length, head: text.slice(0, 120) });
      return cues;
    } catch (error) {
      dbg({ step: "vtt-error", message: String(error) });
      return [];
    }
  }

  async function cuesFromVtt(probe) {
    return cuesFromVttUrl(captionVttUrl(probe));
  }

  /** Udemy's lecture API (same-origin, cookie-authenticated) carries the
   *  caption URLs: fetch it so no transcript panel is needed. */
  function lectureApiUrl(probe, lectureId) {
    const resources = (probe && probe.resources) || [];
    const url = resources.find((candidate) =>
      /\/api-2\.0\/users\/me\/subscribed-courses\/\d+\/lectures\/\d+\//.test(candidate)
    );
    if (!url) return null;
    return lectureId ? url.replace(/(\/lectures\/)\d+(\/)/, `$1${lectureId}$2`) : url;
  }

  function findVttInJson(data) {
    const found = [];
    const walk = (node, depth) => {
      if (!node || depth > 8) return;
      if (typeof node === "string") {
        if (/\.vtt(\?|$)/i.test(node) && !/thumb/i.test(node)) found.push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      if (typeof node === "object") {
        for (const value of Object.values(node)) walk(value, depth + 1);
      }
    };
    walk(data, 0);
    return found.find((url) => /vtt-c\./i.test(url)) || found[0] || null;
  }

  async function vttForLecture(probe, lectureId) {
    const apiUrl = lectureApiUrl(probe, lectureId);
    if (!apiUrl) return null;
    try {
      const response = await fetch(apiUrl, { credentials: "include", headers: { Accept: "application/json" } });
      if (!response.ok) return null;
      return findVttInJson(await response.json());
    } catch (error) {
      console.warn("[speech-trans] lecture API failed", error);
      return null;
    }
  }

  function vttFromLectureApi(probe) {
    return vttForLecture(probe, null);
  }

  /** The transcript panel in Udemy Business has no data-purpose attributes in
   *  some versions; find it by its content instead. */
  function transcriptContainer() {
    const candidates = [...document.querySelectorAll("div, section, aside")].filter((el) => {
      const text = el.innerText || "";
      if (text.length < 100) return false;
      // header appears in the first lines of the panel
      return /transcript/i.test(text.slice(0, 240));
    });
    candidates.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
    return candidates[0] || null;
  }

  /** The lecture player is the largest visible <video>; Udemy also has hidden
   *  preview/ad videos at (0,0) that must not be used for positioning. */
  function videoElement() {
    const videos = [...document.querySelectorAll("video")];
    if (!videos.length) return null;
    let best = null;
    let bestArea = -1;
    for (const video of videos) {
      const rect = video.getBoundingClientRect();
      const style = getComputedStyle(video);
      const visible = rect.width > 80 && rect.height > 60 && style.visibility !== "hidden" && style.display !== "none";
      const area = visible ? rect.width * rect.height : 0;
      if (area > bestArea) {
        best = video;
        bestArea = area;
      }
    }
    return best;
  }

  async function loadTranscript(options = {}) {
    if (transcript.loading) {
      // A second auto-load (or the popup button) while the first run is still
      // translating would pay for the same lesson twice.
      transcriptStatus("Đang dịch transcript…", "info");
      return;
    }
    const token = ++loadToken;
    transcript.loading = true;
    try {
      await loadTranscriptInner(options, token);
    } finally {
      if (token === loadToken) transcript.loading = false;
    }
  }

  async function translateRawCues(raw, key, { report = true } = {}) {
      const batchSize = 20;
      const texts = raw.map((cue) => cue.text);
      const batches = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        batches.push(texts.slice(start, start + batchSize));
      }
      const translations = new Array(texts.length).fill("");
      let nextBatch = 0;
      let done = 0;
      const runBatch = async () => {
        while (true) {
          const index = nextBatch;
          nextBatch += 1;
          if (index >= batches.length) return;
          const slice = batches[index];
          let result = await chrome.runtime.sendMessage({
            from: "content",
            type: "translate-cues",
            cues: slice,
            lesson: key,
          });
          if (!result || result.error) {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            result = await chrome.runtime.sendMessage({
              from: "content",
              type: "translate-cues",
              cues: slice,
              lesson: key,
            });
          }
          if (!result || result.error) throw new Error(result ? result.error : "dịch thất bại");
          const got = result.translations || [];
          const offset = index * batchSize;
          // Never fail the whole transcript: fall back to the English line.
          for (let k = 0; k < slice.length; k += 1) translations[offset + k] = got[k] || slice[k];
          done += slice.length;
          if (report) transcriptStatus(`Đang dịch ${Math.min(done, texts.length)}/${texts.length} câu…`);
        }
      };
      await runBatch(); // one batch at a time: the provider rate-limits bursts
      if (translations.some((line) => !line)) {
        throw new Error("Một số câu chưa dịch được — thử lại.");
      }

      dbg({ step: "translated", count: translations.length });
      cues = raw.map((cue, index) => {
        const start = cue.start;
        const hasEnd = Number.isFinite(cue.end) && cue.end > start;
        const end = hasEnd
          ? cue.end
          : index + 1 < raw.length
            ? raw[index + 1].start
            : start + 4;
        return { start, end, en: cue.text, vi: translations[index] || "" };
      });
      return cues;
  }

  async function loadTranscriptInner(options, token) {
    const { allowSeek = false, ignoreCache = false } = options;
    buildHost(); // make the on-page status + captions visible from the first step
    if (transcript.enabled) {
      transcriptStatus(`Transcript: ${transcript.cues.length} câu`, "info");
      syncTranscript();
      return;
    }
    const key = lessonKey();
    const cacheKey = `tr:${key}`;
    const cached = await chrome.storage.local.get(cacheKey);
    let cues =
      (!ignoreCache && cached && cached[cacheKey] && cached[cacheKey].v === 3 && cached[cacheKey].cues) || [];

    if (!cues.length) {
      transcriptStatus("Đang tìm transcript trên trang…");
      let raw = cuesFromTextTracks();
      let probe = null;
      if (!raw.length) {
        probe = await requestProbe();
        raw = await cuesFromVtt(probe);
        if (!raw.length) raw = await cuesFromVttUrl(await vttFromLectureApi(probe));
        dbg({ step: "vtt", cues: raw.length, hasProbe: Boolean(probe) });
      }
      if (!raw.length) raw = scrapeTranscript();
      if (!raw.length) {
        openTranscriptPanel();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        raw = scrapeTranscript();
      }
      if (!raw.length) {
        // Ask the page (React props / network resources) for timestamps; the
        // result is also written to logs/client.log by the service worker.
        if (!probe) probe = await requestProbe();
        if (!allowSeek) {
          throw new Error(
            "Chưa lấy được mốc thời gian tự động. Mở panel Transcript rồi thử lại, " +
              "hoặc bấm Nạp để đo (video sẽ tua nhanh ~40 s)."
          );
        }
        const proceed = window.confirm(
          "Chưa lấy được mốc thời gian từ dữ liệu trang.\n" +
            "Đo bằng cách tua video qua từng câu (mất ~40 giây, video sẽ nhảy liên tục)?"
        );
        if (!proceed) throw new Error("Đã huỷ đo thời gian.");
        raw = await scrapeTranscriptBySeeking();
      }
      if (!raw.length) {
        const video = document.querySelector("video");
        dbg({ step: "no-cues", tracks: video && video.textTracks ? video.textTracks.length : -1, dom: document.querySelectorAll('[data-purpose="transcript-cue"]').length });
        const tracks = video && video.textTracks ? video.textTracks.length : 0;
        const domCues = document.querySelectorAll('[data-purpose="transcript-cue"]').length;
        const buttons = [...document.querySelectorAll("button, a")].filter((el) =>
          /transcript/i.test((el.getAttribute("aria-label") || "") + " " + (el.textContent || ""))
        ).length;
        const debug = transcriptDebug();
        throw new Error(
          `Không thấy transcript (caption tracks: ${tracks}, cue DOM: ${domCues}, nút transcript: ${buttons}). ` +
            `Mẫu cue: ${debug.sample || "(không có)"} | container: ${debug.container || "?"}`
        );
      }

      cues = await translateRawCues(raw, key);
      await chrome.storage.local.set({ [cacheKey]: { cues, at: Date.now(), v: 3 } });
      dbg({ step: "cached", cues: cues.length, first: cues[0] && cues[0].vi });
    }

    if (token !== loadToken) {
      // The lesson changed while this transcript was translating: keep the
      // cached result but never show the old lesson's cues on the new video.
      dbg({ step: "load-abandoned", href: location.href });
      return;
    }

    transcript.cues = cues;
    transcript.index = -1;
    transcript.key = key;
    transcript.enabled = true;
    buildHost();
    dbg({ step: "enable", cues: cues.length, hasEls: Boolean(els) });
    const video = videoElement();
    if (!video) throw new Error("Không tìm thấy video trên trang");
    if (transcript.timer) clearInterval(transcript.timer);
    transcript.timer = setInterval(syncTranscript, 250);
    syncTranscript(); // show the cue under the playhead right away
    transcriptStatus(`Transcript sẵn sàng: ${cues.length} câu`, "ok");
    // Hide the status bar after a few seconds: subtitles are the point, the
    // "Transcript N/M" label is only useful while loading.
    els.wrap.classList.add("quiet");
    setTimeout(() => {
      if (els && transcript.enabled) els.wrap.classList.add("quiet");
    }, 3000);
    setTimeout(() => prefetchNextLecture(), 4000);
  }

  function clearTranscript() {
    transcript.enabled = false;
    transcript.cues = [];
    transcript.index = -1;
    transcript.key = "";
    if (transcript.timer) clearInterval(transcript.timer);
    transcript.timer = null;
    if (els) els.wrap.classList.remove("show");
    transcriptStatus("Đã tắt phụ đề transcript", "info");
  }

  function cueIndexAt(seconds) {
    const cues = transcript.cues;
    let low = 0;
    let high = cues.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].start <= seconds) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  function syncTranscript() {
    if (!transcript.enabled || !els) return;
    const video = videoElement();
    if (!video) return;
    if (!syncTranscript.logged) {
      syncTranscript.logged = true;
      const rect = video.getBoundingClientRect();
      dbg({ step: "sync", time: video.currentTime, rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)], cues: transcript.cues.length });
    }
    let index = cueIndexAt(video.currentTime + cueOffset);
    if (index < 0) {
      // Before the first cue (or after the last one): show nothing.
      els.wrap.classList.remove("show");
      transcript.index = -1;
      return;
    }
    const cue = transcript.cues[index];
    const cueEnd = Number.isFinite(cue.end) ? cue.end : cue.start + 4;
    if (video.currentTime + cueOffset > cueEnd + 0.25) {
      // Inside a gap between cues: do not keep the previous line on screen.
      els.wrap.classList.remove("show");
      transcript.index = -1;
      return;
    }
    if (!captionsEnabled) {
      // The toggle must win over the 250 ms sync loop.
      els.wrap.classList.remove("show");
      return;
    }
    // Transcript mode keeps the captions visible while a cue is active: no
    // auto-hide, and re-show on every tick (video may be paused).
    positionOverlay();
    startPositionLoop();
    els.wrap.classList.add("show");
    if (index === transcript.index) return;
    transcript.index = index;
    if (syncTranscript.cueLogs === undefined) syncTranscript.cueLogs = 0;
    if (syncTranscript.cueLogs < 200) {
      syncTranscript.cueLogs += 1;
      dbg({
        step: "cue",
        i: index,
        t: Number(video.currentTime.toFixed(2)),
        offset: cueOffset,
        start: Number(cue.start.toFixed(2)),
        end: Number(cueEnd.toFixed(2)),
        en: (cue.en || "").slice(0, 50),
      });
    }
    setLine(els.en, hideEnglish ? "" : cue.en);
    setLine(els.vi, cue.vi);
    if (!syncTranscript.reported) {
      syncTranscript.reported = true;
      setTimeout(() => {
        const style = getComputedStyle(els.wrap);
        dbg({
          step: "overlay",
          cls: els.wrap.className,
          opacity: style.opacity,
          top: els.wrap.style.top,
          left: els.wrap.style.left,
          en: els.en.textContent.slice(0, 60),
          vi: els.vi.textContent.slice(0, 60),
          connected: host.isConnected,
        });
      }, 200);
    }
  }

  document.addEventListener("fullscreenchange", () => {
    if (host) {
      mount();
      positionOverlay();
    }
  });
  window.addEventListener("resize", positionOverlay);
  window.addEventListener("scroll", positionOverlay, { passive: true });

  // Auto-load the transcript whenever the Udemy transcript panel is open (or
  // opened later): no popup click needed. Cached lessons appear instantly.
  const prefetchState = { running: false, attempted: new Set() };

  function currentLectureId() {
    const match = /\/learn\/lecture\/(\d+)/.exec(location.pathname);
    return match ? match[1] : null;
  }

  function lessonKeyForLecture(id) {
    return location.origin + location.pathname.replace(/\/learn\/lecture\/\d+/, `/learn/lecture/${id}`);
  }

  /** Lecture ids in course order, from the player's course-content sidebar. */
  function courseLectureIds() {
    const ids = [];
    for (const link of document.querySelectorAll('a[href*="/learn/lecture/"]')) {
      const match = /\/learn\/lecture\/(\d+)/.exec(link.getAttribute("href") || "");
      if (match && !ids.includes(match[1])) ids.push(match[1]);
    }
    return ids;
  }

  /** Sidebar closed? Ask Udemy for the curriculum (lectures in course order). */
  async function lectureIdsFromApi(probe) {
    const resources = (probe && probe.resources) || [];
    const lectureApi = resources.find((url) => /\/users\/me\/subscribed-courses\/\d+\/lectures\/\d+\//.test(url));
    const courseApi = resources.find((url) => /\/api-2\.0\/courses\/(\d+)\//.test(url));
    const fromLecture = lectureApi && /\/courses\/(\d+)\//.exec(lectureApi);
    const fromCourse = courseApi && /\/api-2\.0\/courses\/(\d+)\//.exec(courseApi);
    const courseId = (fromLecture && fromLecture[1]) || (fromCourse && fromCourse[1]) || null;
    dbg({ step: "curriculum-check", hasProbe: Boolean(probe), resources: resources.length, lectureApi: Boolean(lectureApi), courseId });
    if (!courseId) return [];
    const url =
      `https://${location.hostname}/api-2.0/courses/${courseId}/subscriber-curriculum-items/` +
      "?page_size=1000&fields[lecture]=id,title,sort_order&fields[chapter]=title,sort_order&fields[quiz]=title,sort_order";
    try {
      dbg({ step: "curriculum-url", url: url.slice(0, 140) });
      const response = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
      const text = await response.text();
      dbg({ step: "curriculum-status", status: response.status, length: text.length, head: text.slice(0, 120) });
      if (!response.ok) return [];
      const data = JSON.parse(text);
      const results = Array.isArray(data.results) ? data.results : [];
      dbg({ step: "curriculum-parsed", items: results.length });
      return results.filter((item) => item._class === "lecture" && item.id).map((item) => String(item.id));
    } catch (error) {
      dbg({ step: "prefetch-api-error", message: String(error) });
      return [];
    }
  }

  /** Translate the next lecture ahead of time so it opens instantly. */
  async function prefetchNextLecture() {
    if (prefetchState.running) return;
    let enabled = true;
    try {
      const stored = await chrome.storage.local.get("prefetchNext");
      if (stored.prefetchNext === false) enabled = false;
    } catch {
      /* default on */
    }
    if (!enabled) return;

    const current = currentLectureId();
    let ids = courseLectureIds();
    let index = current ? ids.indexOf(current) : -1;
    let probe = null;
    if (index < 0) {
      probe = await requestProbe();
      ids = await lectureIdsFromApi(probe);
      index = current ? ids.indexOf(current) : -1;
    }
    if (index < 0 || index + 1 >= ids.length) {
      dbg({ step: "prefetch-skip", current, index, total: ids.length });
      return;
    }
    const nextId = ids[index + 1];
    if (prefetchState.attempted.has(nextId)) return;

    const nextKey = lessonKeyForLecture(nextId);
    const cacheKey = `tr:${nextKey}`;
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached && cached[cacheKey] && cached[cacheKey].v === 3 && cached[cacheKey].cues && cached[cacheKey].cues.length) {
      dbg({ step: "prefetch-hit", nextId, cues: cached[cacheKey].cues.length });
      return;
    }

    prefetchState.attempted.add(nextId);
    prefetchState.running = true;
    try {
      dbg({ step: "prefetch-start", nextId, index, total: ids.length });
      if (!probe) probe = await requestProbe();
      const vtt = await vttForLecture(probe, nextId);
      if (!vtt) {
        dbg({ step: "prefetch-no-vtt", nextId });
        return;
      }
      const raw = await cuesFromVttUrl(vtt);
      if (!raw.length) {
        dbg({ step: "prefetch-no-cues", nextId });
        return;
      }
      const cues = await translateRawCues(raw, nextKey, { report: false });
      await chrome.storage.local.set({ [cacheKey]: { cues, at: Date.now(), v: 3 } });
      dbg({ step: "prefetch-done", nextId, cues: cues.length, first: cues[0] && cues[0].vi });
    } catch (error) {
      dbg({ step: "prefetch-error", nextId, message: String(error) });
    } finally {
      prefetchState.running = false;
    }
  }

  function autoLoadTranscript() {
    dbg({ step: "auto-load-start", href: location.href });
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      // keep watching: the user may open the transcript panel much later
      if (tries > 7200) {
        clearInterval(timer);
        return;
      }
      if (!document.querySelector("video")) return;
      if (!autoLoadTranscript.cacheChecked) {
        autoLoadTranscript.cacheChecked = true;
        const key = `tr:${lessonKey()}`;
        const cached = await chrome.storage.local.get(key);
        dbg({ step: "cache", key, hit: Boolean(cached && cached[key]), url: location.href });
        if (cached && cached[key] && cached[key].v === 3 && cached[key].cues && cached[key].cues.length) {
          const list = cached[key].cues;
          const englishLike = list.filter((c) => c.vi && c.en && c.vi.trim() === c.en.trim()).length;
          const badCache = englishLike > Math.max(3, list.length * 0.25);
          dbg({ step: "cache", hit: true, badCache, englishLike });
          clearInterval(timer);
          if (!transcript.enabled) {
            try {
              await loadTranscript({ allowSeek: false, ignoreCache: badCache });
            } catch (error) {
              transcriptStatus(String(error && error.message ? error.message : error), "error");
            }
          }
          return;
        }
      }
      if (tries === 3 || tries === 8) {
        // the player loads the caption VTT by itself: no panel needed
        const probe = await requestProbe();
        const vtt = captionVttUrl(probe) || (await vttFromLectureApi(probe));
        dbg({ step: "probe", resources: probe && probe.resources, vtt });
        if (vtt) {
          clearInterval(timer);
          if (!transcript.enabled) {
            try {
              await loadTranscript({ allowSeek: false });
            } catch (error) {
              transcriptStatus(String(error && error.message ? error.message : error), "error");
            }
          }
          return;
        }
      }
      if (!transcriptContainer()) return; // panel is closed, keep waiting
      clearInterval(timer);
      if (transcript.enabled) return;
      try {
        await loadTranscript({ allowSeek: false });
      } catch (error) {
        transcriptStatus(String(error && error.message ? error.message : error), "error");
      }
    }, 1000);
  }

  // Udemy switches lectures without reloading the page: this content script
  // stays alive, so cues from the previous lesson must be dropped and the new
  // lesson loaded — otherwise subtitles run on the wrong timeline.
  let watchedKey = lessonKey();
  setInterval(() => {
    const key = lessonKey();
    if (key === watchedKey) return;
    watchedKey = key;
    dbg({ step: "lesson-change", key });
    if (transcript.enabled || transcript.loading) clearTranscript();
    loadToken += 1;
    transcript.loading = false;
    setTimeout(() => {
      loadTranscript({ allowSeek: false }).catch((error) =>
        transcriptStatus(String(error && error.message ? error.message : error), "error")
      );
    }, 1500);
  }, 1000);

  dbg({ step: "content-ready", v: "0.3.6", href: location.href });
  if (document.readyState === "complete") autoLoadTranscript();
  else window.addEventListener("load", autoLoadTranscript);

  chrome.runtime
    .sendMessage({ from: "content", type: "get-config" })
    .then((config) => {
      if (!config) return;
      if (typeof config.captions === "boolean") captionsEnabled = config.captions;
      if (Number.isFinite(config.cueOffset)) cueOffset = config.cueOffset;
      if (Number.isFinite(config.captionBottom)) captionBottom = config.captionBottom;
      if (typeof config.hideNative === "boolean") hideNative = config.hideNative;
      if (typeof config.hideEnglish === "boolean") hideEnglish = config.hideEnglish;
      applyNativeCaptionStyle();
      renderCurrentCue();
    })
    .catch(() => {});
})();
