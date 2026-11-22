/** Live transcript + latency table. Data comes from the service worker. */

const $ = (id) => document.getElementById(id);
const els = {
  rows: $("rows"),
  empty: $("empty"),
  count: $("count"),
  avgTotal: $("avgTotal"),
  state: $("state"),
  dot: $("dot"),
  copy: $("copy"),
  clear: $("clear"),
};

/** @type {Map<number, object>} */
const rows = new Map();

function send(message) {
  return chrome.runtime.sendMessage({ from: "transcript", ...message });
}

function ms(value) {
  return Number.isFinite(value) ? `${Math.round(value)} ms` : "–";
}

function secs(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}s` : "–";
}

function clock(epochMs) {
  if (!epochMs) return "–";
  const d = new Date(epochMs);
  return d.toLocaleTimeString("vi-VN", { hour12: false });
}

function cell(text, cls) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

function renderRow(row) {
  let tr = els.rows.querySelector(`tr[data-id="${row.id}"]`);
  if (!tr) {
    tr = document.createElement("tr");
    tr.dataset.id = String(row.id);
    for (let i = 0; i < 8; i += 1) tr.appendChild(document.createElement("td"));
    els.rows.appendChild(tr);
  }
  const total = row.totalMs;
  const totalCls = Number.isFinite(total) ? (total > 1500 ? "num bad" : "num good") : "num";
  const cells = [
    cell(String(row.id), "num"),
    cell(clock(row.at), "num"),
    cell(secs(row.duration), "num"),
    cell(row.en || "…", "en"),
    cell(row.vi || "…", "vi"),
    cell(ms(row.asrMs), "num"),
    cell(ms(row.mtMs), "num"),
    cell(ms(total), totalCls),
  ];
  cells.forEach((td, index) => tr.replaceChild(td, tr.children[index]));
  updateStats();
}

function updateStats() {
  const list = [...rows.values()].sort((a, b) => a.id - b.id);
  els.count.textContent = String(list.length);
  els.empty.style.display = list.length ? "none" : "block";

  const avg = (pick) => {
    const values = list.map(pick).filter((v) => Number.isFinite(v));
    if (!values.length) return NaN;
    return values.reduce((a, b) => a + b, 0) / values.length;
  };
  els.avgTotal.textContent = ms(avg((r) => r.totalMs));

  const last = list[list.length - 1];
  if (last) {
    const running = last.vi ? "đang chạy" : "đang nghe";
    els.state.textContent = `${running} · câu #${last.id}`;
    els.dot.classList.remove("err");
    els.dot.classList.add("ok");
  }
}

function tsv() {
  const header = ["id", "time", "audio_s", "en", "vi", "asr_ms", "mt_ms", "total_ms"];
  const lines = [header.join("\t")];
  for (const row of [...rows.values()].sort((a, b) => a.id - b.id)) {
    lines.push(
      [
        row.id,
        clock(row.at),
        Number.isFinite(row.duration) ? row.duration.toFixed(2) : "",
        (row.en || "").replace(/\t/g, " "),
        (row.vi || "").replace(/\t/g, " "),
        row.asrMs ?? "",
        row.mtMs ?? "",
        row.totalMs ?? "",
      ].join("\t")
    );
  }
  return lines.join("\n");
}

els.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(tsv());
    els.copy.textContent = "Đã copy";
    setTimeout(() => (els.copy.textContent = "Copy TSV"), 1200);
  } catch (error) {
    els.state.textContent = `Không copy được: ${error}`;
  }
});

els.clear.addEventListener("click", async () => {
  rows.clear();
  els.rows.innerHTML = "";
  updateStats();
  els.state.textContent = "đã xoá";
  await send({ type: "clear-transcript" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "utterance" && message.row) {
    rows.set(message.row.id, message.row);
    renderRow(message.row);
  } else if (message.type === "transcript-cleared") {
    rows.clear();
    els.rows.innerHTML = "";
    updateStats();
  }
});

async function init() {
  try {
    const response = await send({ type: "get-transcript" });
    const list = (response && response.rows) || [];
    for (const row of list) rows.set(row.id, row);
    for (const row of [...rows.values()].sort((a, b) => a.id - b.id)) renderRow(row);
    updateStats();
  } catch (error) {
    els.state.textContent = `không đọc được dữ liệu: ${error}`;
    els.dot.classList.add("err");
  }
}

init();
