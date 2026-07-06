/**
 * export-report.ts
 *
 * Standalone script: generates a multi-tab Excel (.xlsx) workbook from one
 * ComplianceReport already in the database, then writes it to export/ at the
 * repo root.
 *
 * Usage (from repo root, with DATABASE_URL pointing to the running postgres):
 *   DATABASE_URL=postgres://qualys:qualys@localhost:5432/qualys \
 *   npx ts-node --project app/tsconfig.json app/src/scripts/export-report.ts \
 *     <reportId> [outputDir]
 *
 * Memory: the workbook is streamed to a temp file via ExcelJS's streaming
 * WorkbookWriter with the two large sheets (FirstScan, _raw RESULTS) fed from
 * cursor-paginated DB reads, so even 50k+ row reports stay well within memory.
 *
 * Charts: none are embedded. The Summary sheet is plain data tables; charts are
 * added downstream when the file is imported into Google Sheets.
 */

import "dotenv/config";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import ExcelJS from "exceljs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

// Streaming WorkbookWriter worksheet type (compatible with the normal Worksheet
// API for our purposes). Used so the sheet builders type-check against either.
type StreamWb = ExcelJS.stream.xlsx.WorkbookWriter;

// ---------------------------------------------------------------------------
// Prisma client type
//
// buildWorkbook receives a PrismaClient from its caller (the Express server
// passes its own long-lived instance; the CLI creates a throwaway one). This
// avoids a second connection pool when imported by server.ts and keeps the
// module side-effect-free on import.
// ---------------------------------------------------------------------------

type Prisma = PrismaClient;

// ---------------------------------------------------------------------------
// Typed errors — let HTTP callers map to the right status code.
//   ReportNotFoundError  → 404
//   ReportMissingOsError → 400 (the section join needs an OS)
// ---------------------------------------------------------------------------

export class ReportNotFoundError extends Error {
  constructor(reportId: string) {
    super(`Report ${reportId} not found`);
    this.name = "ReportNotFoundError";
  }
}

export class ReportMissingOsError extends Error {
  constructor(reportId: string) {
    super(`Report ${reportId} has no OS — re-upload with an OS to export.`);
    this.name = "ReportMissingOsError";
  }
}

// ---------------------------------------------------------------------------
// Export filename: "<title-or-fileName-or-os>_<idshort>.xlsx", sanitized.
// Prefer the short report `title` (e.g. PCReport-KH-Windows2019DC-x64-20260624)
// over the long upload `fileName` for a cleaner download name.
// ---------------------------------------------------------------------------
export function exportFileName(
  reportId: string,
  report: { fileName?: string | null; title?: string | null; os?: string | null },
): string {
  const raw = report.title ?? report.fileName ?? report.os ?? "report";
  // Strip a trailing .csv/.xlsx extension before re-sanitizing.
  const base = raw
    .replace(/\.(csv|xlsx?)$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 60);
  return `${base}_${reportId.slice(0, 8)}.xlsx`;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface SectionRow {
  section_no: number;
  section_name: string;
  passed: bigint;
  failed: bigint;
  total: bigint;
}

interface CritRow {
  criticality_label: string;
  criticality_value: number;
  passed: bigint;
  failed: bigint;
}

interface PriorityRow {
  control_id: number | null;
  control: string | null;
  cnt: bigint;
}

interface ResultRow {
  host_ip: string | null;
  dns_hostname: string | null;
  operating_system: string | null;
  last_scan_date: Date | null;
  evaluation_date: Date | null;
  control_id: number | null;
  control_references: string | null;
  technology: string | null;
  control: string | null;
  criticality_label: string | null;
  criticality_value: number | null;
  instance: string | null;
  status: string | null;
  deprecated: boolean;
  cause_of_failure: string | null;
  qualys_host_id: string | null;
  previous_status: string | null;
  first_fail_date: Date | null;
  last_fail_date: Date | null;
  first_pass_date: Date | null;
  last_pass_date: Date | null;
  section_name: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

// ---------------------------------------------------------------------------
// Helper: format a Date as "YYYY-MM-DD HH:MM:SS" or empty
// ---------------------------------------------------------------------------
function fmtDate(d: Date | null | undefined): string {
  if (!d) return "";
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

// ---------------------------------------------------------------------------
// Helper: derive "Priority" from criticalityLabel
// ---------------------------------------------------------------------------
function derivePriority(label: string | null): string {
  if (!label) return "Optional";
  return label === "HIGH" || label === "MEDIUM" ? "Mandatory" : "Optional";
}

// ---------------------------------------------------------------------------
// Styling helpers
// ---------------------------------------------------------------------------

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F3864" }, // dark navy
};
const HEADER_FONT: Partial<ExcelJS.Font> = { color: { argb: "FFFFFFFF" }, bold: true };

const PASS_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFE2EFDA" }, // light green tint
};
const FAIL_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFCE4D6" }, // light red tint
};

function styleHeaderRow(row: ExcelJS.Row) {
  row.font = HEADER_FONT;
  row.fill = HEADER_FILL;
  row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
}

// ---------------------------------------------------------------------------
// Main workbook builder
// ---------------------------------------------------------------------------

// Cursor-paginated stream over a report's ComplianceResult rows (ordered by id,
// which ≈ original file/insert order). Keeps memory bounded — we never hold all
// rows in a single array. Used for both FirstScan and the _raw RESULTS dump.
async function* streamResults(
  prisma: Prisma,
  reportId: string,
  batchSize = 1000,
): AsyncGenerator<AnyRecord> {
  let cursorId: string | undefined;
  for (;;) {
    const batch = await prisma.complianceResult.findMany({
      where: { reportId },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });
    if (batch.length === 0) break;
    for (const row of batch) yield row;
    cursorId = batch[batch.length - 1].id as string;
    if (batch.length < batchSize) break;
  }
}

/**
 * Build the workbook to a TEMP FILE and return its path (caller must unlink).
 *
 * Memory-bounded streaming design (replaces the old all-in-memory build that
 * OOM'd on big reports): a streaming WorkbookWriter writes rows to disk as they
 * are committed; the two huge sheets (FirstScan, _raw RESULTS) are fed from
 * cursor-paginated DB reads and committed row-by-row, so neither the DB result
 * set nor the workbook model is ever fully held in memory. No charts are
 * embedded — the Summary data tables are the deliverable (charts are added
 * later in Google Sheets).
 */
export async function buildWorkbook(prisma: Prisma, reportId: string): Promise<string> {
  // ---- 1. Report metadata --------------------------------------------------
  const report = await prisma.complianceReport.findUnique({
    where: { id: reportId },
    include: { summaries: true },
  });
  if (!report) throw new ReportNotFoundError(reportId);
  const reportOs = report.os;
  if (!reportOs) throw new ReportMissingOsError(reportId);
  const s = report.summaries[0] as AnyRecord | undefined;

  // ---- 2. Small aggregate queries (Summary + section mapping) --------------
  const sections = await prisma.$queryRaw<SectionRow[]>`
    SELECT cs.section_no, cs.section_name,
      COUNT(*) FILTER (WHERE cr.status = 'Passed') AS passed,
      COUNT(*) FILTER (WHERE cr.status = 'Failed') AS failed,
      COUNT(*) AS total
    FROM compliance_results cr
    JOIN control_sections cs ON cs.cid = cr.control_id AND cs.os = ${reportOs}
    WHERE cr.report_id = ${reportId}::uuid
    GROUP BY cs.section_no, cs.section_name
    ORDER BY cs.section_no
  `;

  const critRows = await prisma.$queryRaw<CritRow[]>`
    SELECT criticality_label, criticality_value,
      COUNT(*) FILTER (WHERE status = 'Passed') AS passed,
      COUNT(*) FILTER (WHERE status = 'Failed') AS failed
    FROM compliance_results
    WHERE report_id = ${reportId}::uuid AND criticality_label IS NOT NULL
    GROUP BY criticality_label, criticality_value
    ORDER BY criticality_value DESC
  `;

  // Priority = FAILED Mandatory findings grouped by control (computed in SQL so
  // we don't need every result row in memory just to group them).
  const priorityRows = await prisma.$queryRaw<PriorityRow[]>`
    SELECT control_id, control, COUNT(*)::bigint AS cnt
    FROM compliance_results
    WHERE report_id = ${reportId}::uuid
      AND status = 'Failed'
      AND criticality_label IN ('HIGH', 'MEDIUM')
    GROUP BY control_id, control
    ORDER BY cnt DESC, control_id ASC
  `;

  // ControlSection lookup (CID sheet + FirstScan section-name derivation).
  const cidRows = await prisma.controlSection.findMany({
    where: { os: reportOs },
    orderBy: [{ sectionNo: "asc" }, { cid: "asc" }],
    select: { cid: true, sectionNo: true, sectionName: true, os: true },
  });
  const sectionByCid = new Map<number, string>(cidRows.map((c) => [c.cid, c.sectionName]));

  // _raw meta sections (small).
  const controlStats = await prisma.controlStatistic.findMany({
    where: { reportId },
    orderBy: { orderNo: "asc" },
  });
  const hostStats = await prisma.hostStatistic.findMany({
    where: { reportId },
    orderBy: { ipAddress: "asc" },
  });

  console.log(
    `Export ${reportId}: ${report.resultCount} results, ${sections.length} sections, ` +
      `${priorityRows.length} failed-Mandatory controls, ${cidRows.length} CIDs (streaming _raw)`,
  );

  // ---- 3. Stream the workbook to a temp file -------------------------------
  const tmpBase = path.join(os.tmpdir(), `qexport-${crypto.randomUUID()}.xlsx`);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: tmpBase,
    useStyles: true,
    // Inline strings (no shared-string table) so the huge _raw evidence text
    // doesn't accumulate in an in-memory string map — keeps memory bounded.
    useSharedStrings: false,
  });
  wb.creator = "qualys-pc-report-stack";
  wb.created = new Date();

  buildSummarySheet(wb, sections, critRows);
  await streamFirstScanSheet(wb, prisma, reportId, sectionByCid);
  buildPrioritySheet(wb, priorityRows);
  await streamRawSheet(wb, report, s, controlStats, hostStats, prisma, reportId);
  buildCidSheet(wb, cidRows, reportOs);

  await wb.commit(); // finalize the workbook on disk

  // Charts are intentionally NOT embedded — the Summary data tables are the
  // deliverable; charts are added downstream when the file is imported into
  // Google Sheets.
  return tmpBase;
}

// ---------------------------------------------------------------------------
// Sheet: Summary
// ---------------------------------------------------------------------------

// Summary sheet — plain data tables (no charts, no fills), laid out exactly:
//   A1: Control Criticality | B1: Passed | C1: Failed
//   A2: Mandatory (=HIGH+MEDIUM) | A3: Optional (=the rest)
//   (rows 4-5 blank)
//   A6: Section Name | B6: Passed | C6: Failed | D6: Total
//   A7… one row per section | then Total row | then "% pass / failed" row
// Charts are added downstream (in Google Sheets), so none are embedded here.
function buildSummarySheet(wb: StreamWb, sections: SectionRow[], critRows: CritRow[]): void {
  const ws = wb.addWorksheet("Summary");
  const NUM = "#,##0";
  const PCT = "0.00%";

  // ---- Control Criticality (rows 1-3) --------------------------------------
  let mandP = 0,
    mandF = 0,
    optP = 0,
    optF = 0;
  for (const c of critRows) {
    if (c.criticality_label === "HIGH" || c.criticality_label === "MEDIUM") {
      mandP += Number(c.passed);
      mandF += Number(c.failed);
    } else {
      optP += Number(c.passed);
      optF += Number(c.failed);
    }
  }
  ws.getRow(1).values = ["Control Criticality", "Passed", "Failed"];
  const critData: [string, number, number][] = [
    ["Mandatory", mandP, mandF],
    ["Optional", optP, optF],
  ];
  for (let i = 0; i < critData.length; i++) {
    const [label, p, f] = critData[i];
    const row = ws.getRow(2 + i);
    row.values = [label, p, f];
    row.getCell(2).numFmt = NUM;
    row.getCell(3).numFmt = NUM;
  }

  // ---- Section table (header at row 6) -------------------------------------
  const SECT_HEADER = 6;
  ws.getRow(SECT_HEADER).values = ["Section Name", "Passed", "Failed", "Total"];

  let totalPassed = 0,
    totalFailed = 0,
    grandTotal = 0;
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const passed = Number(sec.passed);
    const failed = Number(sec.failed);
    const total = Number(sec.total);
    const row = ws.getRow(SECT_HEADER + 1 + i);
    row.values = [sec.section_name, passed, failed, total];
    row.getCell(2).numFmt = NUM;
    row.getCell(3).numFmt = NUM;
    row.getCell(4).numFmt = NUM;
    totalPassed += passed;
    totalFailed += failed;
    grandTotal += total;
  }

  // Total row
  const totalRow = ws.getRow(SECT_HEADER + 1 + sections.length);
  totalRow.values = ["Total", totalPassed, totalFailed, grandTotal];
  totalRow.getCell(2).numFmt = NUM;
  totalRow.getCell(3).numFmt = NUM;
  totalRow.getCell(4).numFmt = NUM;

  // "% pass / failed" row (overall) — stored as fractions with a percent format.
  const pctRow = ws.getRow(SECT_HEADER + 2 + sections.length);
  pctRow.values = [
    "% pass / failed",
    grandTotal > 0 ? totalPassed / grandTotal : 0,
    grandTotal > 0 ? totalFailed / grandTotal : 0,
  ];
  pctRow.getCell(2).numFmt = PCT;
  pctRow.getCell(3).numFmt = PCT;

  ws.getColumn(1).width = 40;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 12;
  ws.getColumn(4).width = 12;

  ws.commit();
}

// ---------------------------------------------------------------------------
// Sheet: FirstScan
// ---------------------------------------------------------------------------

const FIRST_SCAN_HEADERS = [
  "Host IP",
  "DNS Hostname",
  "Operating System",
  "Last Scan Date",
  "Evaluation Date",
  "Control ID",
  "Control References",
  "Technology",
  "Control",
  "Criticality Label",
  "Priority",
  "Section Control",
  "Criticality Value",
  "Instance",
  "Status",
  "Deprecated",
  "Cause of Failure",
  "Qualys Host ID",
  "Previous Status",
  "First Fail Date",
  "Last Fail Date",
  "First Pass Date",
  "Last Pass Date",
];

// Streams every result row into the FirstScan sheet from a cursor-paginated DB
// read, committing each row so memory stays bounded. Section name is derived
// from the in-memory ControlSection map (no per-row JOIN). Rows are ordered by
// id (≈ original file order) rather than host/control, a tradeoff for streaming.
async function streamFirstScanSheet(
  wb: StreamWb,
  prisma: Prisma,
  reportId: string,
  sectionByCid: Map<number, string>,
) {
  // Streaming worksheets take `views` via options (the property is read-only).
  const ws = wb.addWorksheet("FirstScan", { views: [{ state: "frozen", ySplit: 1 }] });

  // Column widths MUST be set before the first row commit.
  const colWidths = [15, 25, 35, 18, 18, 12, 20, 22, 60, 18, 12, 45, 16, 10, 10, 12, 40, 36, 15, 18, 18, 18, 18];
  for (let i = 0; i < colWidths.length; i++) {
    ws.getColumn(i + 1).width = colWidths[i];
  }

  const hRow = ws.addRow(FIRST_SCAN_HEADERS);
  styleHeaderRow(hRow);
  hRow.height = 24;
  hRow.commit();

  for await (const r of streamResults(prisma, reportId)) {
    const row = ws.addRow([
      r.hostIp ?? "",
      r.dnsHostname ?? "",
      r.operatingSystem ?? "",
      r.lastScanDate ? fmtDate(r.lastScanDate as Date) : "",
      r.evaluationDate ? fmtDate(r.evaluationDate as Date) : "",
      r.controlId ?? "",
      r.controlReferences ?? "",
      r.technology ?? "",
      r.control ?? "",
      r.criticalityLabel ?? "",
      derivePriority(r.criticalityLabel ?? null),
      (r.controlId != null ? sectionByCid.get(r.controlId) : undefined) ?? "",
      r.criticalityValue ?? "",
      r.instance ?? "",
      r.status ?? "",
      r.deprecated ? "TRUE" : "FALSE",
      r.causeOfFailure ?? "",
      r.qualysHostId ?? "",
      r.previousStatus ?? "",
      r.firstFailDate ? fmtDate(r.firstFailDate as Date) : "",
      r.lastFailDate ? fmtDate(r.lastFailDate as Date) : "",
      r.firstPassDate ? fmtDate(r.firstPassDate as Date) : "",
      r.lastPassDate ? fmtDate(r.lastPassDate as Date) : "",
    ]);
    if (r.status === "Passed") row.getCell(15).fill = PASS_FILL;
    if (r.status === "Failed") row.getCell(15).fill = FAIL_FILL;
    row.commit();
  }

  await ws.commit();
}

// ---------------------------------------------------------------------------
// Sheet: Priority
// ---------------------------------------------------------------------------

// Priority = FAILED Mandatory findings, grouped by control (precomputed in SQL).
// rows = Priority → Control, value = count of failing Host IPs. Small sheet, so
// it's built fully then committed.
function buildPrioritySheet(wb: StreamWb, priorityRows: PriorityRow[]) {
  const ws = wb.addWorksheet("Priority", { views: [{ state: "frozen", ySplit: 1 }] });

  ws.getColumn(1).width = 14;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 70;
  ws.getColumn(4).width = 18;

  const hRow = ws.getRow(1);
  hRow.values = ["Priority", "Control ID", "Control", "Count of Host IP"];
  styleHeaderRow(hRow);
  hRow.height = 24;

  let rowNum = 2;
  let total = 0;
  for (let i = 0; i < priorityRows.length; i++) {
    const p = priorityRows[i];
    const cnt = Number(p.cnt);
    total += cnt;
    ws.getRow(rowNum).values = [i === 0 ? "Mandatory" : "", p.control_id ?? "", p.control ?? "", cnt];
    if (i === 0) ws.getCell(`A${rowNum}`).font = { bold: true };
    rowNum++;
  }

  ws.getRow(rowNum + 1).values = ["", "", "TOTAL", total];
  ws.getRow(rowNum + 1).font = { bold: true };

  ws.commit();
}

// ---------------------------------------------------------------------------
// Sheet: _raw
// ---------------------------------------------------------------------------

// Full original Qualys RESULTS column set (UN-trimmed) — faithful recreation of
// the uploaded file. Order follows the template's RESULTS/FirstScan header order;
// the trimmed columns (Evidence, Rationale, Remediation, Exception*, NETWORK,
// NetBIOS, Tracking Method) that FirstScan drops are KEPT here.
const RAW_RESULT_HEADERS = [
  "Host IP",
  "DNS Hostname",
  "NetBIOS Hostname",
  "Tracking Method",
  "Operating System",
  "NETWORK",
  "Last Scan Date",
  "Evaluation Date",
  "Control ID",
  "Control References",
  "Technology",
  "Control",
  "Criticality Label",
  "Criticality Value",
  "Instance",
  "Rationale",
  "Status",
  "Remediation",
  "Deprecated",
  "Evidence",
  "Exception Assignee",
  "Exception Status",
  "Exception End Date",
  "Exception Creator",
  "Exception Created Date",
  "Exception Modifier",
  "Exception Modified Date",
  "Cause of Failure",
  "Qualys Host ID",
  "Previous Status",
  "First Fail Date",
  "Last Fail Date",
  "First Pass Date",
  "Last Pass Date",
];

async function streamRawSheet(
  wb: StreamWb,
  report: AnyRecord,
  summary: AnyRecord | undefined,
  controlStats: AnyRecord[],
  hostStats: AnyRecord[],
  prisma: Prisma,
  reportId: string,
) {
  const ws = wb.addWorksheet("_raw");

  // Column widths must be set before the first row commit (which happens once we
  // start streaming RESULTS), so set them up front.
  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 35;
  ws.getColumn(3).width = 12;
  ws.getColumn(4).width = 60;
  ws.getColumn(5).width = 20;
  ws.getColumn(6).width = 16;
  ws.getColumn(7).width = 12;
  ws.getColumn(8).width = 14;
  ws.getColumn(9).width = 14;

  let r = 1;

  ws.getCell(`A${r}`).value = "Policy Compliance Report";
  ws.getCell(`A${r}`).font = { bold: true, size: 13 };
  ws.getRow(r).height = 20;
  r++;

  const setMeta = (label: string, value: string) => {
    ws.getCell(`A${r}`).value = label;
    ws.getCell(`B${r}`).value = value;
    r++;
  };
  setMeta("Title:", report.title ?? "");
  setMeta("Generated:", report.generatedAt ? fmtDate(new Date(report.generatedAt as string)) : "");
  setMeta("Company:", report.companyName ?? "");
  setMeta("OS:", report.os ?? "");
  r++;

  // SUMMARY
  ws.getCell(`A${r}`).value = "SUMMARY";
  ws.getCell(`A${r}`).font = { bold: true };
  r++;
  if (summary) {
    const sumHeaders = [
      "Policy ID", "Policy Title", "Controls", "Assets", "Passed", "Passed%", "Failures", "Failures%",
    ];
    const hRow = ws.getRow(r);
    hRow.values = sumHeaders;
    styleHeaderRow(hRow);
    r++;
    ws.getRow(r).values = [
      summary.policyId,
      summary.policyTitle,
      summary.controls ?? "",
      summary.assets ?? "",
      summary.passed ?? "",
      summary.passedPct ?? "",
      summary.failures ?? "",
      summary.failuresPct ?? "",
    ];
    r++;
  }
  r++;

  // CONTROL STATISTICS
  ws.getCell(`A${r}`).value = "CONTROL STATISTICS";
  ws.getCell(`A${r}`).font = { bold: true };
  r++;
  {
    const csHeaders = [
      "Order No", "Control ID", "Deprecated", "Statement",
      "Criticality Label", "Criticality Value", "Percentage", "Passed Hosts", "Total Hosts",
    ];
    ws.getRow(r).values = csHeaders;
    styleHeaderRow(ws.getRow(r));
    r++;
    for (const cs of controlStats) {
      ws.getRow(r).values = [
        cs.orderNo, cs.controlId, cs.deprecated ? "TRUE" : "FALSE", cs.statement,
        cs.criticalityLabel ?? "", cs.criticalityValue ?? "", cs.percentage ?? "",
        cs.passedHosts ?? "", cs.totalHosts ?? "",
      ];
      r++;
    }
  }
  r++;

  // HOST STATISTICS
  ws.getCell(`A${r}`).value = "HOST STATISTICS";
  ws.getCell(`A${r}`).font = { bold: true };
  r++;
  {
    const hsHeaders = [
      "IP Address", "Tracking Method", "DNS Name", "NetBIOS Name", "OS",
      "Last Scan Date", "Percentage", "Passed Controls", "Total Controls",
      "Qualys Host ID", "Host ID", "Asset Tags",
    ];
    ws.getRow(r).values = hsHeaders;
    styleHeaderRow(ws.getRow(r));
    r++;
    for (const hs of hostStats) {
      ws.getRow(r).values = [
        hs.ipAddress, hs.trackingMethod ?? "", hs.dnsName ?? "", hs.netbiosName ?? "",
        hs.operatingSystem ?? "", hs.lastScanDate ? fmtDate(hs.lastScanDate as Date) : "",
        hs.percentage ?? "", hs.passedControls ?? "", hs.totalControls ?? "",
        hs.qualysHostId ?? "", hs.hostId ?? "", hs.assetTags ?? "",
      ];
      r++;
    }
  }
  r++;

  // RESULTS — full faithful dump (all original Qualys columns, un-trimmed),
  // streamed row-by-row from the DB so the huge evidence/remediation/rationale
  // text is never all held in memory.
  ws.getCell(`A${r}`).value = "RESULTS";
  ws.getCell(`A${r}`).font = { bold: true };
  r++;
  const resHRow = ws.getRow(r);
  resHRow.values = RAW_RESULT_HEADERS;
  styleHeaderRow(resHRow);
  resHRow.commit(); // flushes the meta rows above + this header
  r++;

  for await (const cr of streamResults(prisma, reportId)) {
    const row = ws.getRow(r);
    row.values = [
      cr.hostIp ?? "",
      cr.dnsHostname ?? "",
      cr.netbiosHostname ?? "",
      cr.trackingMethod ?? "",
      cr.operatingSystem ?? "",
      cr.network ?? "",
      cr.lastScanDate ? fmtDate(cr.lastScanDate as Date) : "",
      cr.evaluationDate ? fmtDate(cr.evaluationDate as Date) : "",
      cr.controlId ?? "",
      cr.controlReferences ?? "",
      cr.technology ?? "",
      cr.control ?? "",
      cr.criticalityLabel ?? "",
      cr.criticalityValue ?? "",
      cr.instance ?? "",
      cr.rationale ?? "",
      cr.status ?? "",
      cr.remediation ?? "",
      cr.deprecated ? "TRUE" : "FALSE",
      cr.evidence ?? "",
      cr.exceptionAssignee ?? "",
      cr.exceptionStatus ?? "",
      cr.exceptionEndDate ? fmtDate(cr.exceptionEndDate as Date) : "",
      cr.exceptionCreator ?? "",
      cr.exceptionCreatedDate ? fmtDate(cr.exceptionCreatedDate as Date) : "",
      cr.exceptionModifier ?? "",
      cr.exceptionModifiedDate ? fmtDate(cr.exceptionModifiedDate as Date) : "",
      cr.causeOfFailure ?? "",
      cr.qualysHostId ?? "",
      cr.previousStatus ?? "",
      cr.firstFailDate ? fmtDate(cr.firstFailDate as Date) : "",
      cr.lastFailDate ? fmtDate(cr.lastFailDate as Date) : "",
      cr.firstPassDate ? fmtDate(cr.firstPassDate as Date) : "",
      cr.lastPassDate ? fmtDate(cr.lastPassDate as Date) : "",
    ];
    row.commit();
    r++;
  }

  await ws.commit();
}

// ---------------------------------------------------------------------------
// Sheet: CID
// ---------------------------------------------------------------------------

function buildCidSheet(
  wb: StreamWb,
  cidRows: { cid: number; sectionNo: number; sectionName: string; os: string }[],
  os: string,
) {
  const ws = wb.addWorksheet("CID", { views: [{ state: "frozen", ySplit: 2 }] });

  ws.getCell("A1").value = `ControlSection lookup for OS: ${os}`;
  ws.getCell("A1").font = { bold: true };

  const hRow = ws.getRow(2);
  hRow.values = ["CID", "Section No", "Section Name", "OS"];
  styleHeaderRow(hRow);

  ws.getColumn(1).width = 10;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 70;
  ws.getColumn(4).width = 16;

  let r = 3;
  for (const row of cidRows) {
    ws.getRow(r).values = [row.cid, row.sectionNo, row.sectionName, row.os];
    r++;
  }

  ws.commit();
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const reportId = process.argv[2];
  const outputDir = process.argv[3] ?? path.resolve(__dirname, "../../../../export");

  if (!reportId) {
    console.error("Usage: export-report.ts <reportId> [outputDir]");
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log(`Building workbook for report ${reportId} …`);
    const tmpPath = await buildWorkbook(prisma, reportId);

    const report = await prisma.complianceReport.findUnique({
      where: { id: reportId },
      select: { fileName: true, title: true, os: true },
    });
    const fileName = exportFileName(reportId, report ?? {});
    const outPath = path.join(outputDir, fileName);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(tmpPath, outPath);
    fs.unlinkSync(tmpPath);
    console.log(`Written: ${outPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run the CLI when invoked directly (e.g. `node dist/scripts/export-report.js`).
// When imported by server.ts this guard prevents the CLI from auto-running.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
