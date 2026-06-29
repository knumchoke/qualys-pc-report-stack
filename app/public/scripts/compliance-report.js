const $ = (id) => document.getElementById(id);
const reportId = new URLSearchParams(location.search).get("id");

let page = 1;
let pageSize = 25;
let total = 0;
let searchTimer = null;

// Host statistics pagination state.
let hostPage = 1;
let hostPageSize = 20;
let hostTotal = 0;
let hostSearchTimer = null;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function fmtDate(s) {
  if (!s) return "—";
  try { return new Date(s).toLocaleString(); } catch { return s; }
}
function statusBadge(s) {
  const cls = s === "Passed" ? "pass" : s === "Failed" ? "fail" : "neutral";
  return `<span class="badge ${cls}">${esc(s || "—")}</span>`;
}

async function loadReport() {
  if (!reportId) {
    $("title").textContent = "Missing report id";
    return;
  }
  const res = await fetch(`/api/compliance-reports/${reportId}`);
  if (!res.ok) {
    $("title").textContent = "Report not found";
    return;
  }
  const r = await res.json();
  $("title").textContent = r.title || r.fileName;

  // Show executive link only when the report has an OS (required for section mapping).
  if (r.os) {
    const el = $("execLink");
    el.href = `/compliance-executive.html?id=${reportId}`;
    el.style.display = "";
  }

  $("meta").innerHTML = `
    <dt>File</dt><dd>${esc(r.fileName)}</dd>
    <dt>Generated</dt><dd>${esc(fmtDate(r.generatedAt))}</dd>
    <dt>Uploaded</dt><dd>${esc(fmtDate(r.createdAt))}</dd>
    <dt>Company</dt><dd>${esc(r.companyName || "—")}</dd>`;

  // Summary stats from the first policy summary.
  const s = (r.summaries || [])[0];
  if (s) {
    $("summaryStats").innerHTML = `
      <div class="stat unchanged"><div class="n">${esc(s.assets ?? "—")}</div><div class="l">Hosts</div></div>
      <div class="stat unchanged"><div class="n">${esc(s.controls ?? "—")}</div><div class="l">Controls</div></div>
      <div class="stat create"><div class="n">${esc(s.passed ?? "—")}</div><div class="l">Passed ${s.passedPct != null ? "(" + s.passedPct + "%)" : ""}</div></div>
      <div class="stat update"><div class="n">${esc(s.failures ?? "—")}</div><div class="l">Failed ${s.failuresPct != null ? "(" + s.failuresPct + "%)" : ""}</div></div>`;
  }

  // Failed-controls breakdown by criticality.
  const fbc = r.failedByCriticality || [];
  $("failedByCrit").innerHTML = fbc.length
    ? '<span class="muted">Failed by criticality:</span>' +
      fbc.map((c) => `<span class="chip">${esc(c.label || "—")} <b>${esc(c.count)}</b></span>`).join("")
    : "";

  // Populate the results criticality filter (labels ordered by severity desc).
  const sel = $("criticality");
  const current = sel.value;
  sel.innerHTML =
    '<option value="">All criticality</option>' +
    (r.criticalityLabels || []).map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
  sel.value = current;
}

async function loadHosts() {
  hostPageSize = Number($("hostPageSize").value);
  const params = new URLSearchParams({ page: hostPage, pageSize: hostPageSize, q: $("hostSearch").value.trim() });
  const res = await fetch(`/api/compliance-reports/${reportId}/hosts?` + params.toString());
  const json = await res.json();
  hostTotal = json.total;
  const hosts = json.data || [];

  $("hostRows").innerHTML = hosts.length
    ? hosts
        .map(
          (h) => `
      <tr>
        <td>${esc(h.ipAddress)}</td>
        <td class="muted">${esc(h.operatingSystem || "—")}</td>
        <td>${esc(h.passedControls)} / ${esc(h.totalControls)}</td>
        <td>${esc(h.percentage != null ? h.percentage + "%" : "—")}</td>
        <td class="muted">${esc(fmtDate(h.lastScanDate))}</td>
      </tr>`,
        )
        .join("")
    : '<tr><td class="empty" colspan="5">No hosts match.</td></tr>';

  const pages = Math.max(1, Math.ceil(hostTotal / hostPageSize));
  const from = hostTotal === 0 ? 0 : (hostPage - 1) * hostPageSize + 1;
  const to = Math.min(hostPage * hostPageSize, hostTotal);
  $("hostSummary").textContent = `${from}–${to} of ${hostTotal}`;
  $("hostPrev").disabled = hostPage <= 1;
  $("hostNext").disabled = hostPage >= pages;
}

async function loadResults() {
  pageSize = Number($("pageSize").value);
  const params = new URLSearchParams({
    page,
    pageSize,
    status: $("status").value,
    criticality: $("criticality").value,
    q: $("search").value.trim(),
  });
  const res = await fetch(`/api/compliance-reports/${reportId}/results?` + params.toString());
  const json = await res.json();
  total = json.total;
  const data = json.data || [];

  $("resultRows").innerHTML = data.length
    ? data
        .map(
          (r) => `
      <tr>
        <td>${esc(r.hostIp)}</td>
        <td>${esc(r.controlId)}</td>
        <td>${esc(r.control || "—")}</td>
        <td class="muted">${esc(r.criticalityLabel || "—")}</td>
        <td>${statusBadge(r.status)}</td>
        <td class="actions"><button class="linklike" data-view="${esc(r.id)}">View</button></td>
      </tr>`,
        )
        .join("")
    : '<tr><td class="empty" colspan="6">No results match.</td></tr>';

  $("resultRows").querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => viewResult(b.getAttribute("data-view"))),
  );

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  $("resultSummary").textContent = `${from}–${to} of ${total}`;
  $("prev").disabled = page <= 1;
  $("next").disabled = page >= pages;
}

async function viewResult(id) {
  const res = await fetch(`/api/compliance-results/${id}`);
  if (!res.ok) return;
  const r = await res.json();
  $("mTitle").innerHTML = `Control ${esc(r.controlId)} · ${statusBadge(r.status)}`;
  const block = (label, val) => (val ? `<h3>${esc(label)}</h3><pre>${esc(val)}</pre>` : "");
  $("mBody").innerHTML = `
    <dl class="meta">
      <dt>Host</dt><dd>${esc(r.hostIp)} (${esc(r.dnsHostname || "—")})</dd>
      <dt>Technology</dt><dd>${esc(r.technology || "—")}</dd>
      <dt>Criticality</dt><dd>${esc(r.criticalityLabel || "—")} (${esc(r.criticalityValue ?? "—")})</dd>
      <dt>Instance</dt><dd>${esc(r.instance || "—")}</dd>
      <dt>Last scan</dt><dd>${esc(fmtDate(r.lastScanDate))}</dd>
    </dl>
    <p style="margin:0.75rem 0 0;">${esc(r.control || "")}</p>
    ${block("Rationale", r.rationale)}
    ${block("Evidence", r.evidence)}
    ${block("Remediation", r.remediation)}
    ${block("Cause of failure", r.causeOfFailure)}`;
  $("overlay").classList.add("show");
}
function closeModal() { $("overlay").classList.remove("show"); }

$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { page = 1; loadResults(); }, 300);
});
$("status").addEventListener("change", () => { page = 1; loadResults(); });
$("criticality").addEventListener("change", () => { page = 1; loadResults(); });
$("pageSize").addEventListener("change", () => { page = 1; loadResults(); });
$("prev").addEventListener("click", () => { if (page > 1) { page--; loadResults(); } });
$("next").addEventListener("click", () => { page++; loadResults(); });
$("closeBtn").addEventListener("click", closeModal);
$("overlay").addEventListener("click", (e) => { if (e.target === $("overlay")) closeModal(); });

// Host statistics controls.
$("hostSearch").addEventListener("input", () => {
  clearTimeout(hostSearchTimer);
  hostSearchTimer = setTimeout(() => { hostPage = 1; loadHosts(); }, 300);
});
$("hostPageSize").addEventListener("change", () => { hostPage = 1; loadHosts(); });
$("hostPrev").addEventListener("click", () => { if (hostPage > 1) { hostPage--; loadHosts(); } });
$("hostNext").addEventListener("click", () => { hostPage++; loadHosts(); });

loadReport();
loadHosts();
loadResults();
