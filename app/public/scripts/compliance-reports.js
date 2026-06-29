const API = "/api/compliance-reports";
const $ = (id) => document.getElementById(id);

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
  const res = await fetch(API);
  const json = await res.json();
  const data = json.data || [];
  $("summary").textContent = data.length + " report(s)";
  const tbody = $("rows");
  if (!data.length) {
    tbody.innerHTML = '<tr><td class="empty" colspan="8">No reports uploaded yet.</td></tr>';
    return;
  }
  tbody.innerHTML = data
    .map(
      (r) => `
    <tr>
      <td class="filecell"><a href="/compliance-report.html?id=${esc(r.id)}">${esc(r.fileName)}</a></td>
      <td>${esc(r.os || "—")}</td>
      <td class="muted">${esc(r.title || "—")}</td>
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

load();
