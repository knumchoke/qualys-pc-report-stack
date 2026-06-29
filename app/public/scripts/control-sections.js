const API = "/api/control-sections";
let page = 1;
let pageSize = 20;
let total = 0;
let searchTimer = null;

const $ = (id) => document.getElementById(id);

function toast(msg, ok = true) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show " + (ok ? "ok" : "err");
  setTimeout(() => (t.className = "toast"), 2500);
}

function fmtDate(s) {
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function load() {
  const q = $("search").value.trim();
  pageSize = Number($("pageSize").value);
  const params = new URLSearchParams({ page, pageSize, q });
  const res = await fetch(API + "?" + params.toString());
  const json = await res.json();
  total = json.total;
  renderRows(json.data);
  renderPager();
}

function renderRows(data) {
  const tbody = $("rows");
  if (!data.length) {
    tbody.innerHTML = '<tr><td class="empty" colspan="6">No records found.</td></tr>';
    return;
  }
  tbody.innerHTML = data
    .map(
      (r) => `
    <tr>
      <td>${esc(r.cid)}</td>
      <td>${esc(r.os)}</td>
      <td>${esc(r.sectionNo)}</td>
      <td>${esc(r.sectionName)}</td>
      <td class="muted">${esc(fmtDate(r.updatedAt))}</td>
      <td class="actions">
        <button class="ghost" data-edit='${esc(JSON.stringify(r))}'>Edit</button>
        <button class="danger" data-del="${esc(r.id)}" data-label="CID ${esc(r.cid)} / ${esc(r.os)}">Delete</button>
      </td>
    </tr>`,
    )
    .join("");

  tbody.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openModal(JSON.parse(b.getAttribute("data-edit")))),
  );
  tbody.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => del(b.getAttribute("data-del"), b.getAttribute("data-label"))),
  );
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  $("summary").textContent = `${from}–${to} of ${total}`;
  $("prev").disabled = page <= 1;
  $("next").disabled = page >= pages;
}

// ----- modal -----
function openModal(record) {
  $("formErr").textContent = "";
  if (record) {
    $("modalTitle").textContent = "Edit record";
    $("f-id").value = record.id;
    $("f-cid").value = record.cid;
    $("f-os").value = record.os;
    $("f-sectionNo").value = record.sectionNo;
    $("f-sectionName").value = record.sectionName;
  } else {
    $("modalTitle").textContent = "Add record";
    ["f-id", "f-cid", "f-os", "f-sectionNo", "f-sectionName"].forEach((id) => ($(id).value = ""));
  }
  $("overlay").classList.add("show");
}
function closeModal() { $("overlay").classList.remove("show"); }

async function save() {
  const id = $("f-id").value;
  const body = {
    cid: Number($("f-cid").value),
    os: $("f-os").value.trim(),
    sectionNo: Number($("f-sectionNo").value),
    sectionName: $("f-sectionName").value.trim(),
  };
  $("saveBtn").disabled = true;
  try {
    const res = await fetch(id ? `${API}/${id}` : API, {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      $("formErr").textContent = json.error || `HTTP ${res.status}`;
      return;
    }
    closeModal();
    toast(id ? "Record updated" : "Record created");
    await load();
  } catch (e) {
    $("formErr").textContent = e.message;
  } finally {
    $("saveBtn").disabled = false;
  }
}

async function del(id, label) {
  if (!confirm(`Delete ${label}?`)) return;
  try {
    const res = await fetch(`${API}/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      const json = await res.json().catch(() => ({}));
      toast(json.error || `HTTP ${res.status}`, false);
      return;
    }
    toast("Record deleted");
    // If we deleted the last row on a page, step back.
    if (page > 1 && total - 1 <= (page - 1) * pageSize) page--;
    await load();
  } catch (e) {
    toast(e.message, false);
  }
}

// ----- events -----
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { page = 1; load(); }, 300);
});
$("pageSize").addEventListener("change", () => { page = 1; load(); });
$("prev").addEventListener("click", () => { if (page > 1) { page--; load(); } });
$("next").addEventListener("click", () => { page++; load(); });
$("addBtn").addEventListener("click", () => openModal(null));
$("cancelBtn").addEventListener("click", closeModal);
$("saveBtn").addEventListener("click", save);
$("overlay").addEventListener("click", (e) => { if (e.target === $("overlay")) closeModal(); });

load();
