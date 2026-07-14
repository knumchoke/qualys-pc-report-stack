// Shared rendering of PolicySummary.assetTags — used by the report list and the
// report detail page so both show the same chips.

// Parse PolicySummary.assetTags into { included:{op,tags[]}, excluded:{op,tags[]} }.
// Input: "Included(all): Region - VN, EC2-aarch64, OS: Amazon Linux 2023;\nExcluded(any): EC2-x64;"
function parseAssetTags(raw) {
  if (!raw) return null;
  const result = {};
  // Match each "Included(...)" or "Excluded(...)" group up to the next semicolon or end.
  const re = /(Included|Excluded)\(([^)]+)\)\s*:\s*([^;]+)/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const kind = m[1].toLowerCase();   // "included" | "excluded"
    const op   = m[2].trim();           // "all" | "any"
    const tags = m[3].split(",").map((t) => t.trim()).filter(Boolean);
    result[kind] = { op, tags };
  }
  return Object.keys(result).length ? result : null;
}

function renderAssetTags(raw) {
  const e = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const parsed = parseAssetTags(raw);
  if (!parsed) return "";

  let html = "";
  if (parsed.included) {
    html += `<span class="at-label">Included (${e(parsed.included.op)}):</span>`;
    html += parsed.included.tags.map((t) => `<span class="asset-chip include">${e(t)}</span>`).join("");
  }
  if (parsed.excluded) {
    if (html) html += `<span class="at-label" style="margin-left:0.5rem">Excluded (${e(parsed.excluded.op)}):</span>`;
    else html += `<span class="at-label">Excluded (${e(parsed.excluded.op)}):</span>`;
    html += parsed.excluded.tags.map((t) => `<span class="asset-chip exclude">${e(t)}</span>`).join("");
  }
  return html;
}
