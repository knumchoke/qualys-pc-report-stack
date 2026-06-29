const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const filenameEl = document.getElementById("filename");
const resultEl = document.getElementById("result");
const osSelect = document.getElementById("os");
const osErr = document.getElementById("osErr");

const API = "/api/compliance-reports/upload";

// Populate the mandatory OS picker from ControlSection's known OS keys.
async function loadOsOptions() {
  try {
    const res = await fetch("/api/control-sections/os");
    const json = await res.json();
    (json.data || []).forEach((os) => {
      const opt = document.createElement("option");
      opt.value = os;
      opt.textContent = os;
      osSelect.appendChild(opt);
    });
  } catch (e) {
    osErr.textContent = "Could not load OS list: " + e.message;
  }
}
loadOsOptions();
function reflectOsState() {
  dropzone.style.opacity = osSelect.value ? "1" : "0.55";
}
osSelect.addEventListener("change", () => { osErr.textContent = ""; reflectOsState(); });
reflectOsState();

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function showResult(ok, title, detail) {
  resultEl.className = "result show " + (ok ? "ok" : "err");
  resultEl.innerHTML = "<strong>" + esc(title) + "</strong>" + (detail ? "<pre>" + esc(detail) + "</pre>" : "");
}

async function upload(file) {
  if (!file) return;
  const os = osSelect.value;
  if (!os) {
    osErr.textContent = "Please select an OS before uploading.";
    osSelect.focus();
    return;
  }
  if (!file.name.toLowerCase().endsWith(".csv")) {
    showResult(false, "Not a CSV file", "Expected a .csv file, got: " + file.name);
    return;
  }
  filenameEl.textContent = file.name;
  showResult(true, "Uploading & importing " + file.name + " (" + os + ")…", "This can take a while for large files.");

  try {
    // The raw file IS the request body — streamed to the server, not buffered.
    const res = await fetch(
      API + "?fileName=" + encodeURIComponent(file.name) + "&os=" + encodeURIComponent(os),
      {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: file,
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showResult(false, "Import failed", data.error || "HTTP " + res.status);
      return;
    }
    const c = data.counts || {};
    showResult(
      true,
      "Import complete",
      "Summaries: " + c.summaries +
        "\nControl statistics: " + c.controlStats +
        "\nHost statistics: " + c.hostStats +
        "\nResults: " + c.results +
        "\n\nView it under Compliance → Reports.",
    );
  } catch (e) {
    showResult(false, "Import failed", e.message);
  }
}

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => upload(fileInput.files[0]));

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }),
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); }),
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  fileInput.value = "";
  upload(file);
});
