const $ = (id) => document.getElementById(id);
const reportId = new URLSearchParams(location.search).get("id");

function esc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
  );
}

// ── Section stepped-area SVG ─────────────────────────────────────────────────

function buildSectionSvg(sections) {
  // Chart geometry
  const CX = 38, CY = 14, CW = 600, CH = 148, SW = CW / sections.length;
  const bottom = CY + CH;

  // Y position of the pass/fail boundary for each section
  const ys = sections.map((s) => CY + (1 - s.passedPct / 100) * CH);

  // Build the stepped boundary path (shared by green fill, red fill, and the divider line)
  function steppedPath(startX, startY) {
    let d = `M ${startX} ${startY}`;
    sections.forEach((_, i) => {
      d += ` H ${CX + (i + 1) * SW}`;
      if (i < sections.length - 1) d += ` V ${ys[i + 1]}`;
    });
    return d;
  }

  const greenFill =
    steppedPath(CX, ys[0]) + ` L ${CX + CW} ${bottom} L ${CX} ${bottom} Z`;
  const redFill =
    `M ${CX} ${CY} L ${CX} ${ys[0]}` +
    steppedPath(CX, ys[0]).slice(`M ${CX} ${ys[0]}`.length) +
    ` L ${CX + CW} ${CY} Z`;
  const divLine = steppedPath(CX, ys[0]);

  // Horizontal grid lines at 25 / 50 / 75 %
  const grid = [25, 50, 75]
    .map((pct) => {
      const y = CY + (1 - pct / 100) * CH;
      return (
        `<line x1="${CX}" y1="${y}" x2="${CX + CW}" y2="${y}"` +
        ` stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="4 3"/>` +
        `<text x="${CX - 4}" y="${y + 4}" text-anchor="end" font-size="9" fill="#475569">${pct}%</text>`
      );
    })
    .join("");

  // Vertical column dividers
  const vdiv = sections
    .slice(1)
    .map((_, i) => {
      const x = CX + (i + 1) * SW;
      return `<line x1="${x}" y1="${CY}" x2="${x}" y2="${bottom}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`;
    })
    .join("");

  // Per-section labels and count boxes
  const labels = sections
    .map((s, i) => {
      const xl = CX + i * SW;
      const xm = xl + SW / 2;
      const y = ys[i];
      const greenH = bottom - y;

      let t = "";

      // Passed % inside green area (only when tall enough to read)
      if (greenH > 28) {
        t += `<text x="${xm}" y="${y + greenH / 2 + 5}" text-anchor="middle"
          font-size="13" font-weight="700" fill="rgba(4,40,15,0.95)">${s.passedPct}%</text>`;
      }

      // Total count in a subtle box at the very bottom of the bar
      const bx = xl + 2, bw = SW - 4, bh = 17, by = bottom - bh - 1;
      t += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}"
        fill="rgba(15,23,42,0.7)" rx="2"/>`;
      t += `<text x="${xm}" y="${by + bh - 4}" text-anchor="middle"
        font-size="9.5" fill="#64748b">${s.total.toLocaleString()}</text>`;

      return t;
    })
    .join("");

  const viewH = bottom + 4;
  return `<svg viewBox="0 0 660 ${viewH}" preserveAspectRatio="none"
    style="width:100%;display:block;border-radius:8px;overflow:hidden">
    <rect x="0" y="0" width="660" height="${viewH}" fill="#0a1929"/>
    ${grid}
    ${vdiv}
    <path d="${greenFill}" fill="rgba(74,222,128,0.82)"/>
    <path d="${redFill}"   fill="rgba(248,113,113,0.72)"/>
    <path d="${divLine}"   fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="1.5"/>
    ${labels}
  </svg>`;
}

// ── Criticality horizontal stacked bars ─────────────────────────────────────

const CRIT_COLOR = {
  HIGH:      "#f87171",
  MEDIUM:    "#fbbf24",
  LOW:       "#60a5fa",
  MINIMAL:   "#a78bfa",
  INFO:      "#94a3b8",
  UNDEFINED: "#64748b",
};

function buildCritBars(criticality) {
  return criticality
    .map((c) => {
      const total = c.passed + c.failed;
      if (total === 0) return "";
      const passPct = Math.round((c.passed / total) * 100);
      const failPct = 100 - passPct;
      const col = CRIT_COLOR[c.label] || "#94a3b8";
      const passInner = passPct > 9 ? c.passed.toLocaleString() : "";
      const failInner = failPct > 9 ? c.failed.toLocaleString() : "";
      return `<div class="crit-row">
        <div class="crit-lbl">
          <span style="color:${col};font-weight:700">${esc(c.label)}</span>
          <span class="muted">${c.passed.toLocaleString()} pass · ${c.failed.toLocaleString()} fail</span>
        </div>
        <div class="crit-bar">
          ${passPct > 0 ? `<div class="cb-p" style="width:${passPct}%">${passInner}</div>` : ""}
          ${failPct > 0 ? `<div class="cb-f" style="width:${failPct}%">${failInner}</div>` : ""}
        </div>
      </div>`;
    })
    .join("");
}

// ── HIGH findings cards ───────────────────────────────────────────────────────

function buildFindings(highFindings) {
  const { total, items } = highFindings;
  if (items.length === 0) {
    return '<p class="muted">No HIGH criticality failures.</p>';
  }

  let html = "";
  items.forEach((item, i) => {
    html += `<div class="exec-card">
      <div class="exec-card-n">${item.count}</div>
      <div class="exec-card-sub">Finding</div>
      <div class="exec-card-txt">${esc(item.control)}</div>
    </div>`;
    if (i < items.length - 1) {
      html += '<div class="exec-arrow" aria-hidden="true">→</div>';
    }
  });

  html += `<div class="exec-arrow" aria-hidden="true">→</div>
    <div class="exec-total-badge">
      <div class="exec-total-n">${total}</div>
      <div class="exec-total-sub">Finding</div>
    </div>`;

  return html;
}

// ── Main load ─────────────────────────────────────────────────────────────────

async function load() {
  if (!reportId) {
    $("execLoading").hidden = true;
    $("execError").textContent = "No report ID in URL.";
    $("execError").hidden = false;
    return;
  }

  try {
    const res = await fetch(`/api/compliance-reports/${reportId}/executive`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const { report, overall, sections, criticality, highFindings } = await res.json();

    $("backLink").href = `/compliance-report.html?id=${reportId}`;
    document.title = `Executive Report — ${report.title || report.os}`;

    // Header band
    $("execHdr").innerHTML = `
      <span class="exec-hdr-n">${esc(String(report.serverCount))}</span>
      <span class="exec-hdr-word">Server</span>
      <span class="exec-hdr-tag">+</span>
      <span class="exec-hdr-word">CIS</span>
      <span class="exec-hdr-os">${esc(report.os)}</span>
      <span class="exec-hdr-eq">=</span>
      <span class="exec-hdr-tag exec-hdr-results">RESULTS</span>`;

    // Overall % overlay (inserted into the chart-outer div, positioned top-right)
    $("execOverall").innerHTML = `
      <div class="ov-pass">${overall.passedPct ?? "—"}%</div>
      <div class="ov-lbl">Passed</div>
      <div class="ov-fail">${overall.failedPct ?? "—"}%</div>
      <div class="ov-lbl">Failed</div>`;

    // Section SVG
    $("sectionSvgWrap").innerHTML = buildSectionSvg(sections);

    // Section name labels (below SVG, one flex-cell per section)
    $("sectionNames").innerHTML = sections
      .map((s) => `<div class="exec-sname">${esc(s.sectionName)}</div>`)
      .join("");

    // Criticality bars
    $("critBars").innerHTML = buildCritBars(criticality);

    // Slide B header
    $("slideBHeader").innerHTML = `
      Prioritization &mdash; <span class="high-tag">HIGH</span> Criticality`;

    // Findings
    $("findings").innerHTML = buildFindings(highFindings);

    // Reveal slides
    $("execLoading").hidden = true;
    $("slideA").hidden = false;
    $("slideB").hidden = false;
  } catch (err) {
    $("execLoading").hidden = true;
    $("execError").textContent = "Error: " + err.message;
    $("execError").hidden = false;
  }
}

document.addEventListener("DOMContentLoaded", load);
