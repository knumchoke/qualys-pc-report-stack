const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const filenameEl = document.getElementById("filename");
const previewEl = document.getElementById("preview");
const resultEl = document.getElementById("result");
const confirmBtn = document.getElementById("confirmBtn");
const cancelBtn = document.getElementById("cancelBtn");

const API = "/api/control-sections/upload";
// Hold the parsed CSV between preview and apply so we never re-read the file.
let pendingCsv = null;
let pendingName = "";

const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function showResult(ok, title, detail) {
  resultEl.className = "result show " + (ok ? "ok" : "err");
  resultEl.innerHTML = "<strong>" + esc(title) + "</strong>" + (detail ? "<pre>" + esc(detail) + "</pre>" : "");
}
function resetPanels() {
  previewEl.classList.remove("show");
  resultEl.className = "result";
}

// Step 1: read file, ask the server for a dry-run preview.
async function preview(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".csv")) {
    resetPanels();
    showResult(false, "Not a CSV file", "Expected a .csv file, got: " + file.name);
    return;
  }
  filenameEl.textContent = file.name;
  resetPanels();

  try {
    pendingCsv = await file.text();
    pendingName = file.name;
    const res = await fetch(API + "?dryRun=1", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: pendingCsv,
    });
    const data = await res.json();
    if (!res.ok) {
      showResult(false, "Could not read CSV", data.error || "HTTP " + res.status);
      return;
    }
    renderPreview(data);
  } catch (e) {
    showResult(false, "Upload failed", e.message);
  }
}

function renderPreview(data) {
  $("previewMeta").textContent =
    pendingName + " · " + data.received + " row(s) parsed";
  $("nCreate").textContent = data.summary.create;
  $("nUpdate").textContent = data.summary.update;
  $("nUnchanged").textContent = data.summary.unchanged;

  // Updates: show before → after
  const ups = data.updateSample || [];
  if (ups.length) {
    let rows = ups
      .map(
        (u) => `
      <tr>
        <td>${esc(u.cid)}</td>
        <td>${esc(u.os)}</td>
        <td><span class="old">#${esc(u.before.sectionNo)} ${esc(u.before.sectionName)}</span>
            <span class="arrow"> → </span>
            <span class="new">#${esc(u.after.sectionNo)} ${esc(u.after.sectionName)}</span></td>
      </tr>`,
      )
      .join("");
    let more = data.summary.update > ups.length
      ? `<div class="more">…and ${data.summary.update - ups.length} more update(s)</div>` : "";
    $("updateDiff").innerHTML =
      `<div class="diff-title">Updates (${data.summary.update})</div>
       <table><thead><tr><th>CID</th><th>OS</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>${more}`;
  } else {
    $("updateDiff").innerHTML = "";
  }

  // Creates: show new rows
  const crs = data.createSample || [];
  if (crs.length) {
    let rows = crs
      .map(
        (c) => `
      <tr><td>${esc(c.cid)}</td><td>${esc(c.os)}</td><td>#${esc(c.sectionNo)}</td><td>${esc(c.sectionName)}</td></tr>`,
      )
      .join("");
    let more = data.summary.create > crs.length
      ? `<div class="more">…and ${data.summary.create - crs.length} more new row(s)</div>` : "";
    $("createDiff").innerHTML =
      `<div class="diff-title">New rows (${data.summary.create})</div>
       <table><thead><tr><th>CID</th><th>OS</th><th>Section #</th><th>Section name</th></tr></thead><tbody>${rows}</tbody></table>${more}`;
  } else {
    $("createDiff").innerHTML = "";
  }

  const nothing = data.summary.create === 0 && data.summary.update === 0;
  confirmBtn.disabled = nothing;
  confirmBtn.textContent = nothing ? "Nothing to apply" : "Confirm & apply";
  previewEl.classList.add("show");
}

// Step 2: user confirmed — apply the same CSV for real.
async function apply() {
  if (!pendingCsv) return;
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: pendingCsv,
    });
    const data = await res.json();
    previewEl.classList.remove("show");
    if (res.ok) {
      showResult(
        true,
        "Changes applied",
        "Created: " + data.created + "\nUpdated: " + data.updated + "\nUnchanged: " + data.unchanged,
      );
    } else {
      showResult(false, "Apply failed", data.error || "HTTP " + res.status);
    }
  } catch (e) {
    showResult(false, "Apply failed", e.message);
  } finally {
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    pendingCsv = null;
  }
}

function cancel() {
  pendingCsv = null;
  pendingName = "";
  filenameEl.textContent = "";
  resetPanels();
  showResult(true, "Cancelled", "No changes were written to the database.");
}

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => preview(fileInput.files[0]));
confirmBtn.addEventListener("click", apply);
cancelBtn.addEventListener("click", cancel);

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }),
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); }),
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  // Reset the file input so re-dropping the same file still fires change later.
  fileInput.value = "";
  preview(file);
});
