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

// Findings-by-control pagination state.
let findingPage = 1;
let findingPageSize = 25;
let findingTotal = 0;
let findingSearchTimer = null;

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

    // Export-to-Excel needs an OS too (the section join requires it), so it's
    // gated the same way — avoids offering a download that would 400.
    const xl = $("exportXlsxLink");
    xl.href = `/api/compliance-reports/${reportId}/export.xlsx`;
    xl.style.display = "";

    // Criticality + section summary tables also need the OS (section mapping).
    loadSummaryTables();
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

  // Asset tags from the policy summary — blue = included, orange = excluded.
  $("assetTags").innerHTML = renderAssetTags(s?.assetTags ?? null);

  // Populate criticality filters (results + findings) from the same label list.
  const labels = r.criticalityLabels || [];
  const optionsHtml = labels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");

  const sel = $("criticality");
  const current = sel.value;
  sel.innerHTML = '<option value="">All criticality</option>' + optionsHtml;
  sel.value = current;

  const fsel = $("findingCriticality");
  const fcurrent = fsel.value;
  fsel.innerHTML = '<option value="">All criticality</option>' + optionsHtml;
  fsel.value = fcurrent;
}

// Criticality (Mandatory/Optional) + per-section summary tables — same data as
// the Excel export, sourced from the executive endpoint. Skips silently if the
// report has no OS (the section mapping needs it).
async function loadSummaryTables() {
  const res = await fetch(`/api/compliance-reports/${reportId}/executive`);
  if (!res.ok) return;
  const d = await res.json();
  const crit = d.criticality || [];
  const sections = d.sections || [];
  const overall = d.overall || {};
  const n = (v) => Number(v || 0).toLocaleString();
  const sum = (arr, k) => arr.reduce((a, c) => a + (c[k] || 0), 0);

  // Mandatory = HIGH + MEDIUM (criticalityValue >= 4); Optional = the rest.
  const mand = crit.filter((c) => c.value >= 4);
  const opt = crit.filter((c) => c.value < 4);
  const critTable = `
    <table>
      <thead><tr><th>Control Criticality</th><th class="num">Passed</th><th class="num">Failed</th></tr></thead>
      <tbody>
        <tr><td>Mandatory</td><td class="num">${n(sum(mand, "passed"))}</td><td class="num">${n(sum(mand, "failed"))}</td></tr>
        <tr><td>Optional</td><td class="num">${n(sum(opt, "passed"))}</td><td class="num">${n(sum(opt, "failed"))}</td></tr>
      </tbody>
    </table>`;

  const totPassed = overall.passed ?? sum(sections, "passed");
  const totFailed = overall.failed ?? sum(sections, "failed");
  const grand = totPassed + totFailed;
  const passPct = overall.passedPct != null ? overall.passedPct : grand ? (totPassed / grand) * 100 : 0;
  const failPct = overall.failedPct != null ? overall.failedPct : grand ? (totFailed / grand) * 100 : 0;
  const secTable = `
    <table>
      <thead><tr><th>Section Name</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Total</th></tr></thead>
      <tbody>
        ${sections
          .map(
            (s) => `<tr><td>${esc(s.sectionName)}</td><td class="num">${n(s.passed)}</td><td class="num">${n(s.failed)}</td><td class="num">${n(s.total)}</td></tr>`,
          )
          .join("")}
      </tbody>
      <tfoot>
        <tr><td>Total</td><td class="num">${n(totPassed)}</td><td class="num">${n(totFailed)}</td><td class="num">${n(grand)}</td></tr>
        <tr class="pct"><td>% pass / failed</td><td class="num">${Number(passPct).toFixed(1)}%</td><td class="num">${Number(failPct).toFixed(1)}%</td><td class="num"></td></tr>
      </tfoot>
    </table>`;

  $("summaryTables").innerHTML = critTable + secTable;
}

async function loadFindings() {
  findingPageSize = Number($("findingPageSize").value);
  const params = new URLSearchParams({
    page: findingPage,
    pageSize: findingPageSize,
    criticality: $("findingCriticality").value,
    q: $("findingSearch").value.trim(),
  });
  const res = await fetch(`/api/compliance-reports/${reportId}/findings-by-control?` + params.toString());
  if (!res.ok) return;
  const json = await res.json();
  findingTotal = json.total ?? 0;
  const data = json.data || [];

  $("findingRows").innerHTML = data.length
    ? data
        .map(
          (r) => `
      <tr>
        <td>${esc(r.controlId ?? "—")}</td>
        <td>${esc(r.control || "—")}</td>
        <td class="muted">${esc(r.criticalityLabel || "—")}</td>
        <td><b>${Number(r.count).toLocaleString()}</b></td>
      </tr>`,
        )
        .join("")
    : '<tr><td class="empty" colspan="4">No findings.</td></tr>';

  const pages = Math.max(1, Math.ceil(findingTotal / findingPageSize));
  const from = findingTotal === 0 ? 0 : (findingPage - 1) * findingPageSize + 1;
  const to = Math.min(findingPage * findingPageSize, findingTotal);
  $("findingSummary").textContent = `${from}–${to} of ${findingTotal}`;
  $("findingPrev").disabled = findingPage <= 1;
  $("findingNext").disabled = findingPage >= pages;
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

$("findingSearch").addEventListener("input", () => {
  clearTimeout(findingSearchTimer);
  findingSearchTimer = setTimeout(() => { findingPage = 1; loadFindings(); }, 300);
});
$("findingCriticality").addEventListener("change", () => { findingPage = 1; loadFindings(); });
$("findingPageSize").addEventListener("change", () => { findingPage = 1; loadFindings(); });
$("findingPrev").addEventListener("click", () => { if (findingPage > 1) { findingPage--; loadFindings(); } });
$("findingNext").addEventListener("click", () => { findingPage++; loadFindings(); });

loadReport();
loadFindings();
loadHosts();
loadResults();
