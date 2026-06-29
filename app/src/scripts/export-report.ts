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
 * Chart strategy:
 *   exceljs (v4.x) has NO native chart-authoring API — neither addChart on
 *   Workbook nor any chart xform. The type definitions and dist bundle confirm
 *   this. Per spec: "if exceljs cannot produce a given chart at all, say so
 *   explicitly and fall back to a clean data table, documenting the gap."
 *
 *   We DO produce working charts using OOXML injection: after exceljs writes
 *   the xlsx buffer, we open the zip with JSZip (already a transitive dep of
 *   exceljs), inject chart XML parts (xl/charts/chart1.xml, chart2.xml, their
 *   rels and [Content_Types].xml entries), and write the patched zip.
 *
 *   The Summary sheet data tables (rows 6–N) are the chart series source. The
 *   injected chart XML references those cell ranges so Excel reads live data.
 */

import "dotenv/config";
import path from "path";
import fs from "fs";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

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
// OOXML chart injection
//
// exceljs has no chart API; we post-process the xlsx zip.
// After exceljs generates the xlsx buffer, we:
//   1. Parse the zip with JSZip
//   2. Inject xl/charts/chart1.xml and chart2.xml (bar charts)
//   3. Add xl/charts/_rels/chart1.xml.rels and chart2.xml.rels (style refs)
//   4. Inject xl/drawings/drawing1.xml (positions charts on Sheet1/Summary)
//   5. Add xl/drawings/_rels/drawing1.xml.rels
//   6. Patch xl/worksheets/sheet1.xml to reference the drawing
//   7. Patch xl/workbook.xml.rels (no change needed — drawing is sheet-level)
//   8. Patch [Content_Types].xml to register new parts
//
// Chart data references:
//   Chart 1 (Control Criticality): category = crit label col C rows critStart…critEnd
//                                   series Passed = col D, series Failed = col E
//   Chart 2 (Section Heading):     category = section name col B rows sectStart…sectEnd
//                                   series Passed = col C, series Failed = col D
//
// Row indices are 1-based Excel rows embedded in the XML data refs.
// ---------------------------------------------------------------------------

/**
 * Build OOXML bar-chart XML for a bar chart with two series (Passed / Failed).
 * @param chartId   "1" or "2" — used for internal ID references
 * @param title     Chart title string
 * @param sheetName Name of the data sheet (e.g. "Summary")
 * @param catFromRow 1-based first row of category labels
 * @param catToRow   1-based last row of category labels
 * @param catCol     1-based column of category labels (converted to A/B/C…)
 * @param passedCol  1-based column of Passed values
 * @param failedCol  1-based column of Failed values
 * @param barDir     "bar" (horizontal) or "col" (vertical)
 */
function colLetter(col: number): string {
  // Convert 1-based column number to Excel letter(s): 1=A, 26=Z, 27=AA
  let s = "";
  while (col > 0) {
    const rem = (col - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}

function xlRef(sheet: string, fromRow: number, fromCol: number, toRow: number, toCol: number): string {
  return `'${sheet}'!$${colLetter(fromCol)}$${fromRow}:$${colLetter(toCol)}$${toRow}`;
}

function buildBarChartXml(params: {
  chartId: string;
  title: string;
  sheetName: string;
  catFromRow: number;
  catToRow: number;
  catCol: number;
  passedCol: number;
  failedCol: number;
  barDir: "bar" | "col";
}): string {
  const { chartId, title, sheetName, catFromRow, catToRow, catCol, passedCol, failedCol, barDir } = params;
  const count = catToRow - catFromRow + 1;

  const catRef = xlRef(sheetName, catFromRow, catCol, catToRow, catCol);
  const passedRef = xlRef(sheetName, catFromRow, passedCol, catToRow, passedCol);
  const failedRef = xlRef(sheetName, catFromRow, failedCol, catToRow, failedCol);
  const barType = barDir === "bar" ? "bar" : "col";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:date1904 val="0"/>
  <c:lang val="en-US"/>
  <c:roundedCorners val="0"/>
  <c:chart>
    <c:title>
      <c:tx>
        <c:rich>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p><a:r><a:t>${escXml(title)}</a:t></a:r></a:p>
        </c:rich>
      </c:tx>
      <c:overlay val="0"/>
    </c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:layout/>
      <c:barChart>
        <c:barDir val="${barType}"/>
        <c:grouping val="clustered"/>
        <c:varyColors val="0"/>
        <c:ser>
          <c:idx val="0"/>
          <c:order val="0"/>
          <c:tx>
            <c:v>Passed</c:v>
          </c:tx>
          <c:spPr>
            <a:solidFill><a:srgbClr val="4CAF50"/></a:solidFill>
          </c:spPr>
          <c:cat>
            <c:strRef>
              <c:f>${catRef}</c:f>
              <c:strCache><c:ptCount val="${count}"/></c:strCache>
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:f>${passedRef}</c:f>
              <c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${count}"/></c:numCache>
            </c:numRef>
          </c:val>
        </c:ser>
        <c:ser>
          <c:idx val="1"/>
          <c:order val="1"/>
          <c:tx>
            <c:v>Failed</c:v>
          </c:tx>
          <c:spPr>
            <a:solidFill><a:srgbClr val="F44336"/></a:solidFill>
          </c:spPr>
          <c:cat>
            <c:strRef>
              <c:f>${catRef}</c:f>
              <c:strCache><c:ptCount val="${count}"/></c:strCache>
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:f>${failedRef}</c:f>
              <c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${count}"/></c:numCache>
            </c:numRef>
          </c:val>
        </c:ser>
        <c:axId val="${chartId}00"/>
        <c:axId val="${chartId}01"/>
      </c:barChart>
      <c:${barType === "col" ? "cat" : "val"}Ax>
        <c:axId val="${chartId}00"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="${barType === "col" ? "b" : "l"}"/>
        <c:crossAx val="${chartId}01"/>
      </c:${barType === "col" ? "cat" : "val"}Ax>
      <c:${barType === "col" ? "val" : "cat"}Ax>
        <c:axId val="${chartId}01"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="${barType === "col" ? "l" : "b"}"/>
        <c:crossAx val="${chartId}00"/>
      </c:${barType === "col" ? "val" : "cat"}Ax>
    </c:plotArea>
    <c:legend>
      <c:legendPos val="b"/>
      <c:overlay val="0"/>
    </c:legend>
    <c:plotVisOnly val="1"/>
  </c:chart>
</c:chartSpace>`;
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** chart1.xml.rels / chart2.xml.rels — no external relationships needed */
const CHART_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;

/**
 * drawing1.xml — places two charts on the Summary sheet.
 * TWO_CELL_ANCHOR uses col/row indices (0-based EMU offsets → use 0).
 * Position guide:
 *   Chart 1 (Criticality): cols I–P (8–15), rows 4–16 (top under the section header tables)
 *   Chart 2 (Section):     cols I–P (8–15), rows 17–33
 * exceljs col/row in drawings are 0-based.
 */
function buildDrawingXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor moveWithCells="1">
    <xdr:from><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>15</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>16</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="2" name="Chart 1"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
            r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
  <xdr:twoCellAnchor moveWithCells="1">
    <xdr:from><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>17</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>15</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>33</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="3" name="Chart 2"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
            r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`;
}

function buildDrawingRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart"
    Target="../charts/chart1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart"
    Target="../charts/chart2.xml"/>
</Relationships>`;
}

/**
 * Inject chart parts into an xlsx buffer. Returns the patched buffer.
 * @param xlsxBuf  Buffer from workbook.xlsx.writeBuffer()
 * @param chart1Xml OOXML for chart 1
 * @param chart2Xml OOXML for chart 2
 */
async function injectCharts(xlsxBuf: Buffer, chart1Xml: string, chart2Xml: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(xlsxBuf);

  // 1. Add chart files
  zip.file("xl/charts/chart1.xml", chart1Xml);
  zip.file("xl/charts/chart2.xml", chart2Xml);
  zip.file("xl/charts/_rels/chart1.xml.rels", CHART_RELS_XML);
  zip.file("xl/charts/_rels/chart2.xml.rels", CHART_RELS_XML);

  // 2. Add drawing
  zip.file("xl/drawings/drawing1.xml", buildDrawingXml());
  zip.file("xl/drawings/_rels/drawing1.xml.rels", buildDrawingRelsXml());

  // 3. Patch sheet1.xml (Summary) to reference the drawing
  // Find the first worksheet file — it's the first sheet in xl/worksheets/
  const sheetFiles = Object.keys(zip.files).filter((f) => f.match(/^xl\/worksheets\/sheet\d+\.xml$/));
  // Sort numerically so sheet1.xml (Summary) is first
  sheetFiles.sort((a, b) => {
    const na = parseInt(a.match(/(\d+)/)?.[1] ?? "0");
    const nb = parseInt(b.match(/(\d+)/)?.[1] ?? "0");
    return na - nb;
  });
  const sheet1Path = sheetFiles[0];
  if (sheet1Path) {
    let sheet1Xml = await zip.file(sheet1Path)!.async("string");
    // Insert <drawing r:id="rId99"/> before </worksheet> if not already present
    if (!sheet1Xml.includes("<drawing ")) {
      // We need to ensure xmlns:r is on the worksheet element — it usually is
      sheet1Xml = sheet1Xml.replace(
        "</worksheet>",
        `<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId99"/></worksheet>`,
      );
      zip.file(sheet1Path, sheet1Xml);
    }

    // Patch sheet1 rels to add the drawing relationship
    const sheet1Name = sheet1Path.split("/").pop()!;
    const sheet1RelsPath = `xl/worksheets/_rels/${sheet1Name}.rels`;
    let relsXml = "";
    const existingRels = zip.file(sheet1RelsPath);
    if (existingRels) {
      relsXml = await existingRels.async("string");
      // Insert new relationship before </Relationships>
      relsXml = relsXml.replace(
        "</Relationships>",
        `  <Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`,
      );
    } else {
      relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;
    }
    zip.file(sheet1RelsPath, relsXml);
  }

  // 4. Patch [Content_Types].xml
  const ctFile = zip.file("[Content_Types].xml");
  if (ctFile) {
    let ctXml = await ctFile.async("string");
    const chartOverride =
      `<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>` +
      `<Override PartName="/xl/charts/chart2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>` +
      `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`;
    if (!ctXml.includes("chart1.xml")) {
      ctXml = ctXml.replace("</Types>", `${chartOverride}</Types>`);
      zip.file("[Content_Types].xml", ctXml);
    }
  }

  const outputBuf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return outputBuf as Buffer;
}

// ---------------------------------------------------------------------------
// Main workbook builder
// ---------------------------------------------------------------------------

export async function buildWorkbook(prisma: Prisma, reportId: string): Promise<Buffer> {
  // ---- 1. Fetch report metadata ----------------------------------------
  const report = await prisma.complianceReport.findUnique({
    where: { id: reportId },
    include: { summaries: true },
  });
  if (!report) throw new ReportNotFoundError(reportId);
  const os = report.os;
  if (!os) throw new ReportMissingOsError(reportId);

  const s = report.summaries[0] as AnyRecord | undefined;

  // ---- 2. Section pass/fail (same SQL as executive endpoint) ---------------
  const sections = await prisma.$queryRaw<SectionRow[]>`
    SELECT cs.section_no, cs.section_name,
      COUNT(*) FILTER (WHERE cr.status = 'Passed') AS passed,
      COUNT(*) FILTER (WHERE cr.status = 'Failed') AS failed,
      COUNT(*) AS total
    FROM compliance_results cr
    JOIN control_sections cs ON cs.cid = cr.control_id AND cs.os = ${os}
    WHERE cr.report_id = ${reportId}::uuid
    GROUP BY cs.section_no, cs.section_name
    ORDER BY cs.section_no
  `;

  // ---- 3. Criticality breakdown --------------------------------------------
  const critRows = await prisma.$queryRaw<CritRow[]>`
    SELECT criticality_label, criticality_value,
      COUNT(*) FILTER (WHERE status = 'Passed') AS passed,
      COUNT(*) FILTER (WHERE status = 'Failed') AS failed
    FROM compliance_results
    WHERE report_id = ${reportId}::uuid AND criticality_label IS NOT NULL
    GROUP BY criticality_label, criticality_value
    ORDER BY criticality_value DESC
  `;

  // ---- 4. FirstScan data (all results with section join) ------------------
  const firstScanRows = await prisma.$queryRaw<ResultRow[]>`
    SELECT
      cr.host_ip,
      cr.dns_hostname,
      cr.operating_system,
      cr.last_scan_date,
      cr.evaluation_date,
      cr.control_id,
      cr.control_references,
      cr.technology,
      cr.control,
      cr.criticality_label,
      cr.criticality_value,
      cr.instance,
      cr.status,
      cr.deprecated,
      cr.cause_of_failure,
      cr.qualys_host_id,
      cr.previous_status,
      cr.first_fail_date,
      cr.last_fail_date,
      cr.first_pass_date,
      cr.last_pass_date,
      cs.section_name
    FROM compliance_results cr
    LEFT JOIN control_sections cs ON cs.cid = cr.control_id AND cs.os = ${os}
    WHERE cr.report_id = ${reportId}::uuid
    ORDER BY cr.host_ip, cr.control_id
  `;

  // ---- 5. ControlSection lookup (CID sheet) --------------------------------
  const cidRows = await prisma.controlSection.findMany({
    where: { os },
    orderBy: [{ sectionNo: "asc" }, { cid: "asc" }],
    select: { cid: true, sectionNo: true, sectionName: true, os: true },
  });

  // ---- 6. _raw data fetch --------------------------------------------------
  const controlStats = await prisma.controlStatistic.findMany({
    where: { reportId },
    orderBy: { orderNo: "asc" },
  });
  const hostStats = await prisma.hostStatistic.findMany({
    where: { reportId },
    orderBy: { ipAddress: "asc" },
  });
  // Full (UN-TRIMMED) result rows for the _raw RESULTS section — faithful
  // recreation of the original Qualys file, so ALL columns are kept (evidence,
  // remediation, rationale, the Exception* group, NETWORK, NetBIOS, etc.).
  // This is distinct from FirstScan, which stays trimmed per spec.
  const rawResultRows = await prisma.complianceResult.findMany({
    where: { reportId },
    orderBy: [{ hostIp: "asc" }, { controlId: "asc" }],
  });

  // ---- 7. Cell budget estimation ------------------------------------------
  // _raw now contains the FULL RESULTS dump (all RAW_RESULT_HEADERS columns) plus
  // the report header, SUMMARY, CONTROL STATISTICS and HOST STATISTICS sections.
  const rawResultCells = (1 + rawResultRows.length) * RAW_RESULT_HEADERS.length; // header + data
  const rawMetaCells =
    (1 + report.summaryCount) * 8 + // SUMMARY
    (1 + report.controlStatCount) * 9 + // CONTROL STATISTICS
    (1 + report.hostStatCount) * 12 + // HOST STATISTICS
    20; // report header + section titles
  const rawCells = rawResultCells + rawMetaCells;
  // FirstScan = 1 header + firstScanRows.length × 23 cols
  const firstScanCells = (1 + firstScanRows.length) * 23;
  // Summary ~30 rows × 7 cols
  const summaryCells = 30 * 7;
  // Priority bounded by distinct FAILED Mandatory controls + header
  const mandatoryControlCount = new Set(
    firstScanRows
      .filter(
        (r) =>
          r.status === "Failed" &&
          (r.criticality_label === "HIGH" || r.criticality_label === "MEDIUM"),
      )
      .map((r) => r.control_id),
  ).size;
  const priorityCells = (mandatoryControlCount + 5) * 4;
  // CID sheet
  const cidCells = (cidRows.length + 2) * 4;

  const otherCells = summaryCells + firstScanCells + priorityCells + cidCells;
  const totalCells = otherCells + rawCells;
  const includeRaw = totalCells <= 7_000_000;

  console.log(`Cell budget:`);
  console.log(`  Summary:   ${summaryCells.toLocaleString()}`);
  console.log(`  FirstScan: ${firstScanCells.toLocaleString()} (${firstScanRows.length} rows × 23 cols)`);
  console.log(`  Priority:  ${priorityCells.toLocaleString()} (${mandatoryControlCount} distinct FAILED Mandatory controls)`);
  console.log(`  CID:       ${cidCells.toLocaleString()} (${cidRows.length} rows)`);
  console.log(`  _raw:      ${rawCells.toLocaleString()} (incl. ${rawResultRows.length} full RESULTS rows × ${RAW_RESULT_HEADERS.length} cols)`);
  console.log(`  TOTAL:     ${totalCells.toLocaleString()} → _raw ${includeRaw ? "INCLUDED" : "DROPPED"}`);

  // ---- 8. Build workbook --------------------------------------------------
  const wb = new ExcelJS.Workbook();
  wb.creator = "qualys-pc-report-stack";
  wb.created = new Date();

  // We need to know exact row positions for chart data refs before building sheets.
  // Summary sheet layout (fixed regardless of data, except for section count):
  //   Row 1:   Report title
  //   Row 2-4: OS / Generated / Total Servers
  //   Row 5:   blank
  //   Row 6:   "Control Criticality" header
  //   Row 7:   Mandatory summary
  //   Row 8:   Optional summary
  //   Row 9 … 8+critRows.length: per-criticality detail rows
  //   Row 9+critRows.length: blank
  //   Row 10+critRows.length: Section header
  //   Row 11+critRows.length … 10+critRows.length+sections.length: section data
  //   Row 11+critRows.length+sections.length: Total row
  //   Row 12+critRows.length+sections.length: blank
  //   Row 13+critRows.length+sections.length: PolicySummary cross-check

  const CRIT_DETAIL_START = 9; // first criticality detail row (1-based)
  const CRIT_DETAIL_END = 8 + critRows.length;
  const SECT_HEADER_ROW = CRIT_DETAIL_END + 2;
  const SECT_DATA_START = SECT_HEADER_ROW + 1;
  const SECT_DATA_END = SECT_DATA_START + sections.length - 1;

  const { summaryDataRows } = buildSummarySheet(wb, report, s, sections, critRows, {
    critDetailStart: CRIT_DETAIL_START,
    critDetailEnd: CRIT_DETAIL_END,
    sectHeaderRow: SECT_HEADER_ROW,
    sectDataStart: SECT_DATA_START,
    sectDataEnd: SECT_DATA_END,
  });

  buildFirstScanSheet(wb, firstScanRows);
  buildPrioritySheet(wb, firstScanRows);
  if (includeRaw) {
    buildRawSheet(wb, report, s, controlStats, hostStats, rawResultRows);
  } else {
    console.warn("_raw sheet dropped — total cell count exceeds 7,000,000");
  }
  buildCidSheet(wb, cidRows, os);

  // ---- 9. Write to buffer and inject charts --------------------------------
  const xlsxBuf = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);

  // Build chart XMLs with the known row/col positions from Summary sheet
  // Summary column layout:
  //   col A=1: Section No (for section chart categories)
  //   col B=2: Section Name / criticality label (for section/crit chart categories)
  //   col C=3: Passed (section), or criticality label (crit detail row col C=3)
  //   col D=4: Failed (section), or Passed (crit detail)
  //   col E=5: Total, or Failed (crit detail)
  //
  // For criticality chart: category=col C (crit label), passed=col D, failed=col E
  // For section chart:     category=col B (section name), passed=col C, failed=col D

  const chart1Xml = buildBarChartXml({
    chartId: "1",
    title: "Control Criticality — Passed vs Failed",
    sheetName: "Summary",
    catFromRow: CRIT_DETAIL_START,
    catToRow: CRIT_DETAIL_END,
    catCol: 3, // col C: criticality_label
    passedCol: 4, // col D: Passed
    failedCol: 5, // col E: Failed
    barDir: "bar", // horizontal for criticality
  });

  const chart2Xml = buildBarChartXml({
    chartId: "2",
    title: "Section Heading — Passed vs Failed",
    sheetName: "Summary",
    catFromRow: SECT_DATA_START,
    catToRow: SECT_DATA_END,
    catCol: 2, // col B: section name
    passedCol: 3, // col C: Passed
    failedCol: 4, // col D: Failed
    barDir: "bar", // horizontal for sections (long names fit better)
  });

  const patchedBuf = await injectCharts(xlsxBuf, chart1Xml, chart2Xml);

  console.log(`Workbook built: ${summaryDataRows} summary data rows, ${firstScanRows.length} FirstScan rows`);
  return patchedBuf;
}

// ---------------------------------------------------------------------------
// Sheet: Summary
// ---------------------------------------------------------------------------

function buildSummarySheet(
  wb: ExcelJS.Workbook,
  report: AnyRecord,
  s: AnyRecord | undefined,
  sections: SectionRow[],
  critRows: CritRow[],
  layout: {
    critDetailStart: number;
    critDetailEnd: number;
    sectHeaderRow: number;
    sectDataStart: number;
    sectDataEnd: number;
  },
): { summaryDataRows: number } {
  const ws = wb.addWorksheet("Summary");
  const { critDetailStart, critDetailEnd, sectHeaderRow, sectDataStart, sectDataEnd } = layout;

  // ---- A. Report header ---------------------------------------------------
  ws.mergeCells("A1:G1");
  const titleCell = ws.getCell("A1");
  titleCell.value = report.title ?? `Compliance Report — ${report.os}`;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { horizontal: "center" };
  ws.getRow(1).height = 28;

  const setMeta = (row: number, label: string, value: string | number | null) => {
    ws.getCell(`A${row}`).value = label;
    ws.getCell(`A${row}`).font = { bold: true };
    ws.getCell(`B${row}`).value = value ?? "";
  };
  setMeta(2, "OS:", report.os);
  setMeta(3, "Generated:", report.generatedAt ? fmtDate(new Date(report.generatedAt as string)) : "");
  setMeta(4, "Total Servers:", report.hostStatCount);

  // ---- B. Control Criticality group-sum table (rows 6-8+critLen) ----------
  // Row 6 = header (critDetailStart - 3 = CRIT_DETAIL_START - 3)
  const critGroupHeaderRow = critDetailStart - 3; // row 6
  const critHRow = ws.getRow(critGroupHeaderRow);
  critHRow.values = ["", "Control Criticality", "", "Passed", "Failed"];
  styleHeaderRow(critHRow);
  ws.getCell(`B${critGroupHeaderRow}`).alignment = { horizontal: "left" };

  // Mandatory = HIGH + MEDIUM totals (rows 7-8 = critDetailStart - 2, - 1)
  let mandatoryPassed = 0,
    mandatoryFailed = 0;
  let optionalPassed = 0,
    optionalFailed = 0;
  for (const c of critRows) {
    if (c.criticality_label === "HIGH" || c.criticality_label === "MEDIUM") {
      mandatoryPassed += Number(c.passed);
      mandatoryFailed += Number(c.failed);
    } else {
      optionalPassed += Number(c.passed);
      optionalFailed += Number(c.failed);
    }
  }
  const mandRowNum = critGroupHeaderRow + 1; // row 7
  ws.getRow(mandRowNum).values = ["", "Mandatory", "", mandatoryPassed, mandatoryFailed];
  ws.getCell(`D${mandRowNum}`).fill = PASS_FILL;
  ws.getCell(`E${mandRowNum}`).fill = FAIL_FILL;

  const optRowNum = critGroupHeaderRow + 2; // row 8
  ws.getRow(optRowNum).values = ["", "Optional", "", optionalPassed, optionalFailed];
  ws.getCell(`D${optRowNum}`).fill = PASS_FILL;
  ws.getCell(`E${optRowNum}`).fill = FAIL_FILL;

  // Per-criticality detail rows (layout.critDetailStart … critDetailEnd)
  // col A=blank, col B=blank, col C=label, col D=passed, col E=failed
  for (let i = 0; i < critRows.length; i++) {
    const c = critRows[i];
    const rowNum = critDetailStart + i;
    ws.getRow(rowNum).values = ["", "", c.criticality_label, Number(c.passed), Number(c.failed)];
    ws.getCell(`D${rowNum}`).fill = PASS_FILL;
    ws.getCell(`E${rowNum}`).fill = FAIL_FILL;
  }

  // ---- C. Per-Section table -----------------------------------------------
  const sectHRow = ws.getRow(sectHeaderRow);
  sectHRow.values = ["Section No", "Section Name", "Passed", "Failed", "Total", "% Pass", "% Fail"];
  styleHeaderRow(sectHRow);

  let totalPassed = 0,
    totalFailed = 0,
    grandTotal = 0;
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const rowNum = sectDataStart + i;
    const passed = Number(sec.passed);
    const failed = Number(sec.failed);
    const total = Number(sec.total);
    const passPct = total > 0 ? Math.round((passed / total) * 10000) / 100 : 0;
    const failPct = total > 0 ? Math.round((failed / total) * 10000) / 100 : 0;
    ws.getRow(rowNum).values = [sec.section_no, sec.section_name, passed, failed, total, passPct, failPct];
    ws.getCell(`C${rowNum}`).fill = PASS_FILL;
    ws.getCell(`D${rowNum}`).fill = FAIL_FILL;
    totalPassed += passed;
    totalFailed += failed;
    grandTotal += total;
  }

  // Total row
  const totRowNum = sectDataEnd + 1;
  const overallPassPct = grandTotal > 0 ? Math.round((totalPassed / grandTotal) * 10000) / 100 : 0;
  const overallFailPct = grandTotal > 0 ? Math.round((totalFailed / grandTotal) * 10000) / 100 : 0;
  ws.getRow(totRowNum).values = ["", "TOTAL", totalPassed, totalFailed, grandTotal, overallPassPct, overallFailPct];
  ws.getRow(totRowNum).font = { bold: true };
  ws.getCell(`C${totRowNum}`).fill = PASS_FILL;
  ws.getCell(`D${totRowNum}`).fill = FAIL_FILL;

  // PolicySummary cross-check
  if (s) {
    const ovRowNum = totRowNum + 2;
    ws.getRow(ovRowNum).values = [
      "",
      "Overall (PolicySummary)",
      s.passed ?? "",
      s.failures ?? "",
      (s.passed ?? 0) + (s.failures ?? 0),
      s.passedPct ?? "",
      s.failuresPct ?? "",
    ];
    ws.getRow(ovRowNum).font = { italic: true, color: { argb: "FF666666" } };
  }

  // ---- D. Column widths ---------------------------------------------------
  ws.getColumn(1).width = 12;
  ws.getColumn(2).width = 52;
  ws.getColumn(3).width = 12;
  ws.getColumn(4).width = 12;
  ws.getColumn(5).width = 12;
  ws.getColumn(6).width = 10;
  ws.getColumn(7).width = 10;

  return { summaryDataRows: sections.length + critRows.length };
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

function buildFirstScanSheet(wb: ExcelJS.Workbook, rows: ResultRow[]) {
  const ws = wb.addWorksheet("FirstScan");

  const hRow = ws.getRow(1);
  hRow.values = FIRST_SCAN_HEADERS;
  styleHeaderRow(hRow);
  ws.getRow(1).height = 24;

  const colWidths = [15, 25, 35, 18, 18, 12, 20, 22, 60, 18, 12, 45, 16, 10, 10, 12, 40, 36, 15, 18, 18, 18, 18];
  for (let i = 0; i < colWidths.length; i++) {
    ws.getColumn(i + 1).width = colWidths[i];
  }

  ws.views = [{ state: "frozen", ySplit: 1 }];

  let rowNum = 2;
  for (const r of rows) {
    const dataRow = ws.getRow(rowNum);
    dataRow.values = [
      r.host_ip ?? "",
      r.dns_hostname ?? "",
      r.operating_system ?? "",
      r.last_scan_date ? fmtDate(r.last_scan_date) : "",
      r.evaluation_date ? fmtDate(r.evaluation_date) : "",
      r.control_id ?? "",
      r.control_references ?? "",
      r.technology ?? "",
      r.control ?? "",
      r.criticality_label ?? "",
      derivePriority(r.criticality_label),
      r.section_name ?? "",
      r.criticality_value ?? "",
      r.instance ?? "",
      r.status ?? "",
      r.deprecated ? "TRUE" : "FALSE",
      r.cause_of_failure ?? "",
      r.qualys_host_id ?? "",
      r.previous_status ?? "",
      r.first_fail_date ? fmtDate(r.first_fail_date) : "",
      r.last_fail_date ? fmtDate(r.last_fail_date) : "",
      r.first_pass_date ? fmtDate(r.first_pass_date) : "",
      r.last_pass_date ? fmtDate(r.last_pass_date) : "",
    ];
    if (r.status === "Passed") ws.getCell(`O${rowNum}`).fill = PASS_FILL;
    if (r.status === "Failed") ws.getCell(`O${rowNum}`).fill = FAIL_FILL;
    rowNum++;
  }
}

// ---------------------------------------------------------------------------
// Sheet: Priority
// ---------------------------------------------------------------------------

function buildPrioritySheet(wb: ExcelJS.Workbook, firstScanRows: ResultRow[]) {
  const ws = wb.addWorksheet("Priority");

  // Scope: FAILED Mandatory findings only (status='Failed' AND criticality ∈ {HIGH,MEDIUM}).
  // "Count of Host IP" then = number of hosts FAILING each control.
  const mandatoryRows = firstScanRows.filter(
    (r) =>
      r.status === "Failed" &&
      (r.criticality_label === "HIGH" || r.criticality_label === "MEDIUM"),
  );

  // Group by (priority, controlId, control) → count
  const controlMap = new Map<
    string,
    { priority: string; controlId: number | null; control: string; count: number }
  >();
  for (const row of mandatoryRows) {
    const key = `${row.control_id}__${row.control ?? ""}`;
    const existing = controlMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      controlMap.set(key, {
        priority: "Mandatory",
        controlId: row.control_id,
        control: row.control ?? "",
        count: 1,
      });
    }
  }

  const sorted = [...controlMap.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return (a.controlId ?? 0) - (b.controlId ?? 0);
  });

  const hRow = ws.getRow(1);
  hRow.values = ["Priority", "Control ID", "Control", "Count of Host IP"];
  styleHeaderRow(hRow);
  ws.getRow(1).height = 24;

  ws.getColumn(1).width = 14;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 70;
  ws.getColumn(4).width = 18;

  ws.views = [{ state: "frozen", ySplit: 1 }];

  let rowNum = 2;
  let lastPriority = "";
  for (const val of sorted) {
    const dr = ws.getRow(rowNum);
    const showPriority = val.priority !== lastPriority;
    dr.values = [showPriority ? val.priority : "", val.controlId ?? "", val.control, val.count];
    if (showPriority && rowNum === 2) {
      ws.getCell(`A${rowNum}`).font = { bold: true };
    }
    lastPriority = val.priority;
    rowNum++;
  }

  const totalMandatory = mandatoryRows.length;
  ws.getRow(rowNum + 1).values = ["", "", "TOTAL", totalMandatory];
  ws.getRow(rowNum + 1).font = { bold: true };
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

function buildRawSheet(
  wb: ExcelJS.Workbook,
  report: AnyRecord,
  summary: AnyRecord | undefined,
  controlStats: AnyRecord[],
  hostStats: AnyRecord[],
  rawResultRows: AnyRecord[],
) {
  const ws = wb.addWorksheet("_raw");

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

  // RESULTS — full faithful dump (all original Qualys columns, un-trimmed).
  ws.getCell(`A${r}`).value = "RESULTS";
  ws.getCell(`A${r}`).font = { bold: true };
  r++;
  {
    const resHRow = ws.getRow(r);
    resHRow.values = RAW_RESULT_HEADERS;
    styleHeaderRow(resHRow);
    r++;
    for (const cr of rawResultRows) {
      ws.getRow(r).values = [
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
      r++;
    }
  }

  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 35;
  ws.getColumn(3).width = 12;
  ws.getColumn(4).width = 60;
  ws.getColumn(5).width = 20;
  ws.getColumn(6).width = 16;
  ws.getColumn(7).width = 12;
  ws.getColumn(8).width = 14;
  ws.getColumn(9).width = 14;
}

// ---------------------------------------------------------------------------
// Sheet: CID
// ---------------------------------------------------------------------------

function buildCidSheet(
  wb: ExcelJS.Workbook,
  cidRows: { cid: number; sectionNo: number; sectionName: string; os: string }[],
  os: string,
) {
  const ws = wb.addWorksheet("CID");

  ws.getCell("A1").value = `ControlSection lookup for OS: ${os}`;
  ws.getCell("A1").font = { bold: true };

  const hRow = ws.getRow(2);
  hRow.values = ["CID", "Section No", "Section Name", "OS"];
  styleHeaderRow(hRow);

  ws.getColumn(1).width = 10;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 70;
  ws.getColumn(4).width = 16;

  ws.views = [{ state: "frozen", ySplit: 2 }];

  let r = 3;
  for (const row of cidRows) {
    ws.getRow(r).values = [row.cid, row.sectionNo, row.sectionName, row.os];
    r++;
  }
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
    const buf = await buildWorkbook(prisma, reportId);

    const report = await prisma.complianceReport.findUnique({
      where: { id: reportId },
      select: { fileName: true, title: true, os: true },
    });
    const fileName = exportFileName(reportId, report ?? {});
    const outPath = path.join(outputDir, fileName);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outPath, buf);
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
