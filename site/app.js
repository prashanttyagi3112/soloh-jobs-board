"use strict";

const FACETS = [
  { id: "specialty", label: "Specialty", key: "Standard Title" },
  { id: "discipline", label: "Discipline", key: "Discipline", order: ["RN", "LPN/LVN", "CNA", "Allied", "Other"] },
  { id: "city", label: "City", key: "City" },
  { id: "state", label: "State", key: "State" },
];

const MONEY = new Set(["BR", "W2 RT", "Weekly Per Diem", "Gross Weekly Pay", "Target Margin Used"]);
const PERCENT = new Set(["MSP %"]);
const NUMERIC = new Set([
  "Hours/week",
  "Weeks",
  "Openings",
  "BR",
  "W2 RT",
  "Weekly Per Diem",
  "Gross Weekly Pay",
  "Target Margin Used",
  "MSP %",
  "NBO",
]);
const WRAP = new Set(["Facility", "Profession - Specialty", "Job Key", "Job ID"]);
const SOURCE_ORDER = ["HWL", "BudE", "Magnit"];
const CARD_PRIMARY = [
  "Discipline",
  "Shift",
  "Hours/week",
  "Weeks",
  "Openings",
  "BR",
  "Gross Weekly Pay",
  "W2 RT",
  "Source",
  "Target Margin Used",
];

const moneyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const numFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const state = {
  jobs: [],
  columns: [],
  dataDate: "",
  report: null,
  visible: [],
  filters: {
    specialty: new Set(),
    discipline: new Set(),
    city: new Set(),
    state: new Set(),
  },
  query: "",
  showAll: false,
  sortKey: "State",
  sortDir: "asc",
  ready: false,
};

const expanded = new Set();
let expandAll = false;
let booted = false;
let files = null;
let noticeTimer = 0;

const lockForm = document.getElementById("lock-form");
const passwordInput = document.getElementById("password");
const launchBtn = document.getElementById("launch");
const lockStatus = document.getElementById("lock-status");
const searchInput = document.getElementById("search");

function prefersReduced() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setStatus(text) {
  lockStatus.textContent = text;
}

function notify(text) {
  const node = document.getElementById("notice");
  node.textContent = text;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    node.textContent = "";
  }, 4000);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function decryptEnvelope(envelope, password) {
  const salt = b64ToBytes(envelope.salt);
  const iv = b64ToBytes(envelope.iv);
  const ciphertext = b64ToBytes(envelope.ciphertext);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: envelope.iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function formatCell(key, value) {
  if (value == null || value === "") return "—";
  if (typeof value === "number") {
    if (PERCENT.has(key)) {
      const pct = Math.abs(value) <= 1 ? value * 100 : value;
      return `${numFmt.format(pct)}%`;
    }
    if (MONEY.has(key)) return moneyFmt.format(value);
    return numFmt.format(value);
  }
  return String(value);
}

function slug(value) {
  return String(value || "other").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function statusClass(status) {
  if (status === "Open") return "status-open";
  if (status === "Closed") return "status-closed";
  return "status-hold";
}

function haystack(row) {
  if (row.__search) return row.__search;
  row.__search = state.columns
    .map((col) => (row[col] == null ? "" : String(row[col])))
    .join("\n")
    .toLowerCase();
  return row.__search;
}

function matches(row, options = {}) {
  if (!state.showAll && row.Status !== "Open") return false;
  for (const facet of FACETS) {
    if (facet.id === options.ignoreFacet) continue;
    const selected = state.filters[facet.id];
    if (selected.size && !selected.has(String(row[facet.key] ?? ""))) return false;
  }
  if (!options.ignoreSearch && state.query && !haystack(row).includes(state.query)) return false;
  return true;
}

function optionsFor(facet, ignoreSearch) {
  const counts = new Map();
  for (const row of state.jobs) {
    if (!matches(row, { ignoreFacet: facet.id, ignoreSearch })) continue;
    const raw = row[facet.key];
    if (raw == null || raw === "") continue;
    const value = String(raw);
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  for (const value of state.filters[facet.id]) {
    if (!counts.has(value)) counts.set(value, 0);
  }
  const values = [...counts.entries()].map(([value, count]) => ({ value, count }));
  values.sort((a, b) => {
    if (facet.order) {
      const ai = facet.order.indexOf(a.value);
      const bi = facet.order.indexOf(b.value);
      const an = ai === -1 ? 99 : ai;
      const bn = bi === -1 ? 99 : bi;
      if (an !== bn) return an - bn;
    }
    return a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" });
  });
  return values;
}

function pruneFilters() {
  let changed = true;
  let guard = 0;
  while (changed && guard < 6) {
    changed = false;
    guard += 1;
    for (const facet of FACETS) {
      const available = new Set(optionsFor(facet, true).map((opt) => opt.value));
      for (const value of [...state.filters[facet.id]]) {
        if (!available.has(value)) {
          state.filters[facet.id].delete(value);
          changed = true;
        }
      }
    }
  }
}

function compareValues(a, b, key) {
  const va = a[key];
  const vb = b[key];
  const aEmpty = va == null || va === "";
  const bEmpty = vb == null || vb === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const na = asNumber(va);
  const nb = asNumber(vb);
  if (na != null && nb != null) return na - nb;
  if (na != null) return -1;
  if (nb != null) return 1;
  return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" });
}

function compareRows(a, b) {
  const base = compareValues(a, b, state.sortKey);
  if (base === 0) return String(a["Job Key"] || "").localeCompare(String(b["Job Key"] || ""));
  const aEmpty = a[state.sortKey] == null || a[state.sortKey] === "";
  const bEmpty = b[state.sortKey] == null || b[state.sortKey] === "";
  if (aEmpty || bEmpty) return base;
  return state.sortDir === "asc" ? base : -base;
}

function visibleRows() {
  return state.jobs.filter((row) => matches(row)).sort(compareRows);
}

function openingCount(rows) {
  return rows.reduce((sum, row) => sum + (asNumber(row.Openings) || 0), 0);
}

function sourceNames(counts) {
  return [...counts.keys()].sort((a, b) => {
    const ai = SOURCE_ORDER.indexOf(a);
    const bi = SOURCE_ORDER.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.localeCompare(b);
  });
}

function countSources(rows) {
  const counts = new Map();
  for (const row of rows) {
    const name = row.Source || "Unknown";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

function animateCount(node, target) {
  const next = String(target);
  if (node.dataset.target === next) return;
  const shown = Number(String(node.textContent).replace(/,/g, ""));
  const from = Number.isFinite(shown) ? shown : 0;
  node.dataset.target = next;
  if (prefersReduced()) {
    node.textContent = target.toLocaleString();
    node.dataset.value = next;
    return;
  }
  const began = performance.now();
  const duration = 700;
  const token = {};
  node._anim = token;
  function frame(now) {
    if (node._anim !== token) return;
    const progress = Math.min(1, (now - began) / duration);
    const eased = 1 - (1 - progress) ** 3;
    const value = Math.round(from + (target - from) * eased);
    node.textContent = value.toLocaleString();
    if (progress < 1) requestAnimationFrame(frame);
    else node.dataset.value = next;
  }
  requestAnimationFrame(frame);
}

function facetSummary(facet) {
  const selected = [...state.filters[facet.id]];
  if (!selected.length) return "All";
  if (selected.length === 1) return selected[0];
  return `${selected.length} selected`;
}

function buildFacets() {
  const host = document.getElementById("facets");
  for (const facet of FACETS) {
    const root = el("div", "ms");
    root.dataset.facetRoot = facet.id;
    const btn = el("button", "ms-btn");
    btn.type = "button";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", `panel-${facet.id}`);
    btn.append(el("span", "ms-label", facet.label), el("span", "ms-value", "All"));
    const panel = el("div", "ms-panel");
    panel.id = `panel-${facet.id}`;
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", facet.label);
    const search = el("input", "ms-search");
    search.type = "search";
    search.placeholder = `Search ${facet.label.toLowerCase()}`;
    search.setAttribute("aria-label", `Search ${facet.label}`);
    const actions = el("div", "ms-actions");
    const clear = el("button", "text-btn", "Clear");
    clear.type = "button";
    clear.dataset.clearFacet = facet.id;
    actions.appendChild(clear);
    panel.append(search, actions, el("div", "ms-list"));
    root.append(btn, panel);
    host.appendChild(root);
  }
}

function updateFacets() {
  for (const facet of FACETS) {
    const root = document.querySelector(`[data-facet-root="${facet.id}"]`);
    root.querySelector(".ms-value").textContent = facetSummary(facet);
    const query = root.querySelector(".ms-search").value.trim().toLowerCase();
    const list = root.querySelector(".ms-list");
    const scroll = list.scrollTop;
    list.replaceChildren();
    for (const opt of optionsFor(facet, false)) {
      if (query && !opt.value.toLowerCase().includes(query)) continue;
      const label = el("label", "opt");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.facet = facet.id;
      box.value = opt.value;
      box.checked = state.filters[facet.id].has(opt.value);
      label.append(box, el("span", null, opt.value), el("span", "opt-count", String(opt.count)));
      list.appendChild(label);
    }
    if (!list.childElementCount) list.appendChild(el("p", "opt-count", "Nothing in this view"));
    list.scrollTop = scroll;
  }
  renderChips();
}

function renderChips() {
  const host = document.getElementById("chips");
  host.replaceChildren();
  for (const facet of FACETS) {
    for (const value of state.filters[facet.id]) {
      const btn = el("button", "chip");
      btn.type = "button";
      btn.dataset.facet = facet.id;
      btn.dataset.value = value;
      btn.append(document.createTextNode(`${facet.label}: ${value} `), el("span", null, "×"));
      host.appendChild(btn);
    }
  }
  if (state.query) {
    const btn = el("button", "chip");
    btn.type = "button";
    btn.dataset.clearSearch = "1";
    btn.textContent = `Search: ${state.query} ×`;
    host.appendChild(btn);
  }
}

function renderSources(rows) {
  const counts = countSources(rows);
  const ul = document.getElementById("source-counts");
  ul.replaceChildren();
  for (const name of sourceNames(counts)) {
    const li = document.createElement("li");
    li.append(el("strong", null, counts.get(name).toLocaleString()), document.createTextNode(` ${name}`));
    ul.appendChild(li);
  }
}

function renderDropTotals() {
  const counts = countSources(state.jobs);
  const open = state.jobs.filter((row) => row.Status === "Open").length;
  const mix = sourceNames(counts).map((name) => `${name} ${counts.get(name)}`).join(" · ");
  document.getElementById("drop-totals").textContent =
    `This drop: ${state.jobs.length.toLocaleString()} jobs, ${open.toLocaleString()} open · ${mix}`;
  const disc = new Map();
  for (const row of state.jobs) disc.set(row.Discipline, (disc.get(row.Discipline) || 0) + 1);
  document.getElementById("disc-counts").textContent =
    "This file: " +
    ["RN", "LPN/LVN", "CNA", "Allied", "Other"].map((name) => `${name} ${disc.get(name) || 0}`).join(" · ");
}

function renderTable(rows) {
  const head = document.createElement("tr");
  state.columns.forEach((col, index) => {
    const th = document.createElement("th");
    th.scope = "col";
    if (WRAP.has(col)) th.classList.add("wrap");
    if (NUMERIC.has(col)) th.classList.add("num");
    if (index === 0) th.classList.add("sticky");
    if (state.sortKey === col) th.setAttribute("aria-sort", state.sortDir === "asc" ? "ascending" : "descending");
    const btn = el("button", "sort-btn");
    btn.type = "button";
    btn.dataset.sort = col;
    btn.appendChild(el("span", null, col));
    if (col === "BR") btn.title = "Bill rate";
    if (state.sortKey === col) btn.appendChild(el("span", "arrow", state.sortDir === "asc" ? "↑" : "↓"));
    th.appendChild(btn);
    head.appendChild(th);
  });
  document.getElementById("thead").replaceChildren(head);

  const body = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement("tr");
    state.columns.forEach((col, index) => {
      const td = document.createElement("td");
      if (WRAP.has(col)) td.classList.add("wrap");
      if (NUMERIC.has(col)) td.classList.add("num");
      if (index === 0) td.classList.add("sticky");
      if (col === "Status") {
        td.appendChild(el("span", `badge ${statusClass(row[col])}`, formatCell(col, row[col])));
      } else if (col === "Discipline") {
        td.appendChild(el("span", `badge disc disc-${slug(row[col])}`, formatCell(col, row[col])));
      } else {
        td.textContent = formatCell(col, row[col]);
      }
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
  document.getElementById("tbody").replaceChildren(body);
}

function cardFields(row, keys) {
  const dl = document.createElement("dl");
  for (const key of keys) {
    const wrap = document.createElement("div");
    const label = key === "BR" ? "BR (bill rate)" : key;
    wrap.append(el("dt", null, label), el("dd", null, formatCell(key, row[key])));
    dl.appendChild(wrap);
  }
  return dl;
}

function renderCards(rows) {
  const host = document.getElementById("cards");
  const frag = document.createDocumentFragment();
  const primary = CARD_PRIMARY.filter((key) => state.columns.includes(key));
  rows.forEach((row, index) => {
    const key = String(row["Job Key"] || index);
    const card = el("article", "card");
    const head = el("div", "card-head");
    head.append(el("h3", null, formatCell("Standard Title", row["Standard Title"])), el("span", `badge ${statusClass(row.Status)}`, formatCell("Status", row.Status)));
    card.append(
      head,
      el("p", "facility", formatCell("Facility", row.Facility)),
      el("p", "card-where", `${formatCell("City", row.City)}, ${formatCell("State", row.State)}`)
    );
    card.appendChild(cardFields(row, primary));
    const extra = state.columns.filter((col) => !primary.includes(col) && col !== "Standard Title" && col !== "Facility" && col !== "City" && col !== "State");
    if (extra.length) {
      const more = el("div");
      more.hidden = !(expandAll || expanded.has(key));
      more.appendChild(cardFields(row, extra));
      const toggle = el("button", "more", more.hidden ? "All columns" : "Hide extra columns");
      toggle.type = "button";
      toggle.dataset.card = key;
      card.append(toggle, more);
    }
    frag.appendChild(card);
  });
  host.replaceChildren(frag);
}

function render() {
  const rows = visibleRows();
  state.visible = rows;
  const results = document.getElementById("results");
  if (booted && !prefersReduced()) {
    results.classList.add("is-refreshing");
    window.setTimeout(() => results.classList.remove("is-refreshing"), 180);
  }
  booted = true;
  animateCount(document.getElementById("job-count"), rows.length);
  animateCount(document.getElementById("opening-count"), openingCount(rows));
  document.getElementById("view-label").textContent = state.showAll ? "All" : "Open";
  document.getElementById("result-line").textContent =
    `${rows.length.toLocaleString()} matching jobs · ${openingCount(rows).toLocaleString()} openings`;
  renderSources(rows);
  updateFacets();
  renderTable(rows);
  renderCards(rows);
  const empty = rows.length === 0;
  document.getElementById("empty").hidden = !empty;
  document.getElementById("table-wrap").hidden = empty;
  document.getElementById("cards").hidden = empty;
  const sortKey = document.getElementById("sort-key");
  if (sortKey.value !== state.sortKey) sortKey.value = state.sortKey;
  document.getElementById("sort-dir").textContent = state.sortDir === "asc" ? "Ascending" : "Descending";
}

function filterSummary() {
  const parts = [state.showAll ? "All statuses" : "Open only"];
  for (const facet of FACETS) {
    const selected = [...state.filters[facet.id]];
    if (selected.length) parts.push(`${facet.label}: ${selected.join(", ")}`);
  }
  if (state.query) parts.push(`Search: ${state.query}`);
  const text = parts.join(" · ");
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

function exportRows() {
  return state.visible.slice();
}

function exportExcel() {
  if (typeof XLSX === "undefined") throw new Error("Excel library missing");
  const rows = exportRows();
  const data = rows.map((row) => {
    const record = {};
    for (const col of state.columns) record[col] = row[col] == null ? "" : row[col];
    return record;
  });
  const sheet = data.length
    ? XLSX.utils.json_to_sheet(data, { header: state.columns })
    : XLSX.utils.aoa_to_sheet([state.columns]);
  sheet["!cols"] = state.columns.map((col) => ({ wch: Math.min(42, Math.max(12, col.length + 2)) }));
  const book = XLSX.utils.book_new();
  book.Props = { Title: "Soloh Jobs Board", Subject: `Filtered export ${state.dataDate}` };
  XLSX.utils.book_append_sheet(book, sheet, "Jobs");
  XLSX.writeFile(book, `Soloh_Jobs_Board_${state.dataDate}.xlsx`);
}

function exportPdf() {
  if (!window.jspdf || typeof window.jspdf.jsPDF !== "function") throw new Error("PDF library missing");
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a3" });
  const rows = exportRows();
  const body = rows.map((row) => state.columns.map((col) => (row[col] == null || row[col] === "" ? "" : formatCell(col, row[col]))));
  const columnStyles = {};
  state.columns.forEach((col, index) => {
    if (WRAP.has(col)) columnStyles[index] = { cellWidth: 88 };
    else if (col === "Standard Title") columnStyles[index] = { cellWidth: 78 };
    else columnStyles[index] = { cellWidth: "wrap" };
  });
  doc.autoTable({
    head: [state.columns],
    body,
    startY: 36,
    margin: { top: 32, right: 16, bottom: 24, left: 16 },
    styles: { fontSize: 7, cellPadding: 2, textColor: [12, 16, 36], overflow: "linebreak", valign: "top" },
    headStyles: { fillColor: [23, 20, 51], textColor: [244, 247, 251], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [238, 242, 255] },
    columnStyles,
    horizontalPageBreak: true,
    horizontalPageBreakRepeat: 0,
    didDrawPage() {
      const width = doc.internal.pageSize.getWidth();
      const height = doc.internal.pageSize.getHeight();
      doc.setFillColor(16, 18, 48);
      doc.rect(0, 0, width, 22, "F");
      doc.setFontSize(9);
      doc.setTextColor(244, 247, 251);
      doc.text(`Soloh Jobs Board  ·  ${state.dataDate}  ·  ${rows.length} jobs  ·  ${filterSummary()}`, 16, 14);
      doc.setFontSize(8);
      doc.setTextColor(80, 90, 120);
      doc.text(String(doc.internal.getCurrentPageInfo().pageNumber), width - 28, height - 10);
    },
  });
  doc.save(`Soloh_Jobs_Board_${state.dataDate}.pdf`);
}

function exportReport() {
  if (!state.report) return;
  const blob = new Blob([state.report], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = (files && files.pub.reportFilename) || "Chief_of_Jobs_Report.pdf";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function withBusy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  await new Promise((resolve) => window.setTimeout(resolve, 30));
  try {
    fn();
    notify(`Exported ${state.visible.length.toLocaleString()} jobs in the current view.`);
  } catch (err) {
    notify("The export didn't finish. Try again.");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function closePanels() {
  for (const root of document.querySelectorAll(".ms.open")) {
    root.classList.remove("open");
    root.querySelector(".ms-btn").setAttribute("aria-expanded", "false");
  }
}

function buildSortOptions() {
  const select = document.getElementById("sort-key");
  select.replaceChildren();
  for (const col of state.columns) {
    const opt = document.createElement("option");
    opt.value = col;
    opt.textContent = col;
    select.appendChild(opt);
  }
  select.value = state.sortKey;
}

function playLaunch() {
  if (prefersReduced()) return Promise.resolve();
  document.body.classList.add("is-launching");
  if (window.__stars) window.__stars.setWarp(1);
  setStatus("Launch");
  return new Promise((resolve) => window.setTimeout(resolve, 880));
}

function reveal() {
  document.getElementById("data-date").textContent = state.dataDate;
  document.getElementById("lock-date").textContent = state.dataDate;
  const reportBtn = document.getElementById("export-report");
  reportBtn.hidden = !state.report;
  buildSortOptions();
  renderDropTotals();
  render();
  document.getElementById("lock").hidden = true;
  document.getElementById("board").hidden = false;
  if (window.__stars) window.__stars.setWarp(0);
  document.getElementById("board-title").focus();
}

async function unlock(password) {
  const jobsBuf = await decryptEnvelope(files.jobsEnv, password);
  const decoded = JSON.parse(new TextDecoder().decode(jobsBuf));
  let report = null;
  if (files.reportEnv) report = new Uint8Array(await decryptEnvelope(files.reportEnv, password));
  if (!decoded || !Array.isArray(decoded.jobs) || !decoded.meta) throw new Error("Unexpected payload");
  state.jobs = decoded.jobs;
  state.columns = decoded.meta.columns;
  state.dataDate = decoded.meta.dataDate || files.pub.dataDate;
  state.report = report;
}

async function loadFiles() {
  const pubRes = await fetch("data/public.json", { cache: "no-store" });
  if (!pubRes.ok) throw new Error("public");
  const pub = await pubRes.json();
  const version = encodeURIComponent(pub.builtAt || pub.dataDate || "");
  const jobsRes = await fetch(`data/jobs.enc.json?v=${version}`, { cache: "no-store" });
  if (!jobsRes.ok) throw new Error("jobs");
  const jobsEnv = await jobsRes.json();
  let reportEnv = null;
  if (pub.hasReport) {
    const reportRes = await fetch(`data/${pub.reportFile || "report.enc.json"}?v=${version}`, { cache: "no-store" });
    if (!reportRes.ok) throw new Error("report");
    reportEnv = await reportRes.json();
  }
  files = { pub, jobsEnv, reportEnv };
  document.getElementById("lock-date").textContent = pub.dataDate || "";
  state.ready = true;
  launchBtn.disabled = false;
  setStatus("Ready when you are.");
}

function wire() {
  lockForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.ready || !crypto.subtle) return;
    const password = passwordInput.value;
    passwordInput.value = "";
    launchBtn.disabled = true;
    setStatus("Deriving the key…");
    try {
      await unlock(password);
      await playLaunch();
      reveal();
    } catch (err) {
      const card = document.querySelector(".lock-card");
      card.classList.remove("denied");
      void card.offsetWidth;
      card.classList.add("denied");
      setStatus("That password does not open this board.");
      launchBtn.disabled = false;
      passwordInput.focus();
    }
  });

  document.getElementById("lock-btn").addEventListener("click", () => window.location.reload());
  document.getElementById("facets").addEventListener("click", (event) => {
    const clear = event.target.closest("[data-clear-facet]");
    if (clear) {
      state.filters[clear.dataset.clearFacet].clear();
      pruneFilters();
      render();
      return;
    }
    const btn = event.target.closest(".ms-btn");
    if (!btn) return;
    const root = btn.closest(".ms");
    const willOpen = !root.classList.contains("open");
    closePanels();
    if (willOpen) {
      root.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      root.querySelector(".ms-search").focus();
    }
  });
  document.getElementById("facets").addEventListener("change", (event) => {
    const box = event.target;
    if (!box.dataset || !box.dataset.facet) return;
    const selected = state.filters[box.dataset.facet];
    if (box.checked) selected.add(box.value);
    else selected.delete(box.value);
    pruneFilters();
    render();
  });
  document.getElementById("facets").addEventListener("input", (event) => {
    if (event.target.classList.contains("ms-search")) updateFacets();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".ms")) closePanels();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanels();
    if (event.key === "/" && document.getElementById("board").hidden === false && !/input|textarea|select/i.test(event.target.tagName)) {
      event.preventDefault();
      searchInput.focus();
    }
  });
  document.getElementById("chips").addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    if (btn.dataset.clearSearch) {
      state.query = "";
      searchInput.value = "";
    } else if (btn.dataset.facet) {
      state.filters[btn.dataset.facet].delete(btn.dataset.value);
    }
    pruneFilters();
    render();
  });
  let searchTimer = 0;
  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = searchInput.value.trim().toLowerCase();
      render();
    }, 120);
  });
  document.getElementById("show-all").addEventListener("change", (event) => {
    state.showAll = event.target.checked;
    pruneFilters();
    render();
  });
  document.getElementById("reset").addEventListener("click", () => {
    for (const facet of FACETS) state.filters[facet.id].clear();
    state.query = "";
    state.showAll = false;
    searchInput.value = "";
    document.getElementById("show-all").checked = false;
    for (const input of document.querySelectorAll(".ms-search")) input.value = "";
    closePanels();
    render();
  });
  document.getElementById("thead").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-sort]");
    if (!btn) return;
    if (state.sortKey === btn.dataset.sort) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else {
      state.sortKey = btn.dataset.sort;
      state.sortDir = "asc";
    }
    render();
  });
  document.getElementById("sort-key").addEventListener("change", (event) => {
    state.sortKey = event.target.value;
    render();
  });
  document.getElementById("sort-dir").addEventListener("click", () => {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    render();
  });
  document.getElementById("expand-all").addEventListener("click", (event) => {
    expandAll = !expandAll;
    event.currentTarget.textContent = expandAll ? "Collapse cards" : "Expand cards";
    render();
  });
  document.getElementById("cards").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-card]");
    if (!btn) return;
    const key = btn.dataset.card;
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    const more = btn.nextElementSibling;
    if (more) {
      more.hidden = !(expandAll || expanded.has(key));
      btn.textContent = more.hidden ? "All columns" : "Hide extra columns";
    }
  });
  document.getElementById("export-xlsx").addEventListener("click", (event) => {
    withBusy(event.currentTarget, "Preparing…", exportExcel);
  });
  document.getElementById("export-pdf").addEventListener("click", (event) => {
    withBusy(event.currentTarget, "Preparing…", exportPdf);
  });
  document.getElementById("export-report").addEventListener("click", () => {
    exportReport();
    notify("Downloading the original Chief of Jobs report.");
  });
  document.getElementById("mapping").addEventListener("click", () => {
    document.getElementById("mapping-dialog").showModal();
  });
}

function initStars() {
  const canvas = document.getElementById("starfield");
  const ctx = canvas.getContext("2d", { alpha: true });
  const stars = [];
  const colors = ["244,247,251", "244,247,251", "244,247,251", "244,247,251", "45,212,191", "232,121,249"];
  let width = 0;
  let height = 0;
  let warp = 0;
  let parallaxX = 0;
  let parallaxY = 0;
  let targetX = 0;
  let targetY = 0;
  let running = false;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function seed() {
    stars.length = 0;
    const count = Math.min(240, Math.round((width * height) / 8000));
    for (let i = 0; i < count; i += 1) {
      stars.push({
        x: Math.random() * width,
        y: Math.random() * height,
        z: 0.35 + Math.random() * 1.15,
        r: Math.random() < 0.9 ? Math.random() * 1.15 + 0.3 : 1.5 + Math.random(),
        a: 0.35 + Math.random() * 0.65,
        tw: Math.random() * Math.PI * 2,
        color: colors[i % colors.length],
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    const reduce = prefersReduced();
    if (!reduce) {
      parallaxX += (targetX - parallaxX) * 0.06;
      parallaxY += (targetY - parallaxY) * 0.06;
    }
    for (const star of stars) {
      if (!reduce) {
        star.y += star.z * (0.12 + warp * 16);
        star.tw += 0.02;
        if (star.y > height + 8) {
          star.y = -4;
          star.x = Math.random() * width;
        }
      }
      const twinkle = reduce ? 1 : 0.65 + Math.sin(star.tw) * 0.35;
      const x = star.x + parallaxX * star.z;
      const y = star.y + parallaxY * star.z;
      if (warp > 0.05 && !reduce) {
        ctx.strokeStyle = `rgba(${star.color},${0.45 * warp})`;
        ctx.lineWidth = star.r;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - parallaxX * 0.2, y - star.z * warp * 36);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(${star.color},${star.a * twinkle})`;
      ctx.beginPath();
      ctx.arc(x, y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function loop() {
    draw();
    if (!prefersReduced() && running) requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    running = true;
    if (!prefersReduced()) requestAnimationFrame(loop);
    else draw();
  }

  resize();
  seed();
  start();
  window.addEventListener("resize", () => {
    resize();
    seed();
    if (prefersReduced()) draw();
  });
  window.addEventListener("pointermove", (event) => {
    if (prefersReduced() || window.matchMedia("(pointer: coarse)").matches) return;
    targetX = (event.clientX / width - 0.5) * 16;
    targetY = (event.clientY / height - 0.5) * 10;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) running = false;
    else start();
  });
  window.__stars = {
    setWarp(value) {
      warp = value;
    },
  };
}

buildFacets();
wire();
initStars();

if (!window.crypto || !crypto.subtle) {
  setStatus("Open this board on https or http://127.0.0.1 so the browser can decrypt.");
} else {
  loadFiles().catch(() => {
    setStatus("The board files didn't load. Refresh and try again.");
  });
}
