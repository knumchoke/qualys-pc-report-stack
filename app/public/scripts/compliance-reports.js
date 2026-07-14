const API = "/api/compliance-reports";
const $ = (id) => document.getElementById(id);

let page = 1;
let pageSize = 25;
let total = 0;
let searchTimer = null;

function toast(msg, ok = true) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show " + (ok ? "ok" : "err");
  setTimeout(() => (t.className = "toast"), 2500);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function fmtDate(s) {
  if (!s) return "—";
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

async function load() {
  pageSize = Number($("pageSize").value);
  const params = new URLSearchParams({ page, pageSize, q: $("search").value.trim() });
  const res = await fetch(`${API}?` + params.toString());
  const json = await res.json();
  const data = json.data || [];
  total = json.total || 0;
  const tbody = $("rows");
  // Deleting the last row of the last page leaves us past the end — step back.
  if (!data.length && total > 0 && page > 1) {
    page = Math.max(1, Math.ceil(total / pageSize));
    return load();
  }
  if (!data.length) {
    const msg = $("search").value.trim() ? "No reports match your search." : "No reports uploaded yet.";
    tbody.innerHTML = `<tr><td class="empty" colspan="9">${esc(msg)}</td></tr>`;
    renderPager();
    return;
  }
  tbody.innerHTML = data
    .map(
      (r) => `
    <tr>
      <td class="filecell"><a href="/compliance-report.html?id=${esc(r.id)}">${esc(r.fileName)}</a></td>
      <td>${esc(r.os || "—")}</td>
      <td class="muted">${esc(r.title || "—")}</td>
      <td class="tagcell">${renderAssetTags((r.summaries || [])[0]?.assetTags ?? null) || '<span class="muted">—</span>'}</td>
      <td class="muted">${esc(fmtDate(r.generatedAt))}</td>
      <td>${esc(r.hostStatCount)}</td>
      <td>${esc(r.controlStatCount)}</td>
      <td>${esc(r.resultCount)}</td>
      <td class="actions">
        <a href="/compliance-report.html?id=${esc(r.id)}"><button class="ghost" type="button">Open</button></a>
        <button class="danger" data-del="${esc(r.id)}" data-label="${esc(r.fileName)}">Delete</button>
      </td>
    </tr>`,
    )
    .join("");

  tbody.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => del(b.getAttribute("data-del"), b.getAttribute("data-label"))),
  );
  renderPager();
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  $("summary").textContent = `${from}–${to} of ${total} report(s)`;
  $("prev").disabled = page <= 1;
  $("next").disabled = page >= pages;
}

async function del(id, label) {
  if (!confirm(`Delete report "${label}" and all its rows?`)) return;
  try {
    const res = await fetch(`${API}/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      const json = await res.json().catch(() => ({}));
      toast(json.error || `HTTP ${res.status}`, false);
      return;
    }
    toast("Report deleted");
    await load();
  } catch (e) {
    toast(e.message, false);
  }
}

$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { page = 1; load(); }, 300);
});
$("pageSize").addEventListener("change", () => { page = 1; load(); });
$("prev").addEventListener("click", () => { if (page > 1) { page--; load(); } });
$("next").addEventListener("click", () => { page++; load(); });

load();
