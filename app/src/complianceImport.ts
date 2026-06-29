import { Readable } from "stream";
import { parse } from "csv-parse";
import type { PrismaClient } from "./generated/prisma/client";

// ---------------------------------------------------------------------------
// Field parsers for the quirky Qualys formats.
// ---------------------------------------------------------------------------

// "06/25/2026 at 11:37:18 (GMT+0700)" -> Date | null
function parseQDate(v: string | undefined): Date | null {
  if (!v) return null;
  const m = v.match(/(\d{2})\/(\d{2})\/(\d{4})\s+at\s+(\d{2}):(\d{2}):(\d{2})\s*\(GMT([+-]\d{2})(\d{2})\)/);
  if (!m) return null;
  const [, mm, dd, yyyy, hh, mi, ss, oh, om] = m;
  const d = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${oh}:${om}`);
  return isNaN(d.getTime()) ? null : d;
}

function toInt(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = parseInt(v.replace(/[^0-9-]/g, ""), 10);
  return isNaN(n) ? null : n;
}

function toFloat(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function toBool(v: string | undefined): boolean {
  return v === "1" || v?.toLowerCase() === "true";
}

// "455(98.27%)" -> { count: 455, pct: 98.27 } ; "0" -> { count: 0, pct: null }
function parseCountPct(v: string | undefined): { count: number | null; pct: number | null } {
  if (!v) return { count: null, pct: null };
  const m = v.match(/(\d+)\s*\(([\d.]+)%\)/);
  if (m) return { count: parseInt(m[1], 10), pct: parseFloat(m[2]) };
  return { count: toInt(v), pct: null };
}

// "98.27% (455 of 463)" -> { pct: 98.27, passed: 455, total: 463 }
function parsePctOf(v: string | undefined): { pct: number | null; passed: number | null; total: number | null } {
  if (!v) return { pct: null, passed: null, total: null };
  const m = v.match(/([\d.]+)%\s*\((\d+)\s+of\s+(\d+)\)/);
  if (m) return { pct: parseFloat(m[1]), passed: parseInt(m[2], 10), total: parseInt(m[3], 10) };
  return { pct: toFloat(v), passed: null, total: null };
}

type Section = "PREAMBLE" | "SUMMARY" | "CONTROL_STATS" | "HOST_STATS" | "ASSET_TAGS" | "RESULTS";

const RESULTS_BATCH = 500;

export interface ImportResult {
  reportId: string;
  counts: { summaries: number; controlStats: number; hostStats: number; results: number };
}

// Stream-parse a Qualys compliance report CSV and persist it. The small sections
// (summary/control/host stats) are buffered (they're tiny), and the large RESULTS
// section is bulk-inserted in batches so memory stays bounded for 100MB+ files.
export async function importComplianceReport(
  prisma: PrismaClient,
  fileName: string,
  os: string,
  input: Readable,
): Promise<ImportResult> {
  const parser = parse({
    relax_column_count: true, // sections have different column counts
    relax_quotes: true, // tolerate the malformed ASSET TAGS quoting
    skip_empty_lines: true,
    skip_records_with_error: true,
    trim: false, // preserve evidence/remediation formatting
  });

  let section: Section = "PREAMBLE";
  let expectHeader = false; // the row right after a section marker is the column header

  const preamble: string[][] = [];
  const summaries: any[] = [];
  const controlStats: any[] = [];
  const hostStats: any[] = [];
  const assetTagsByIp = new Map<string, string>();

  let reportId: string | null = null;
  let smallSectionsFlushed = false;
  let resultBatch: any[] = [];
  let resultCount = 0;

  const marker = (cell: string): Section | null => {
    const c = (cell || "").trim();
    if (c === "SUMMARY") return "SUMMARY";
    if (c.startsWith("Control Statistics")) return "CONTROL_STATS";
    if (c.startsWith("Host Statistics")) return "HOST_STATS";
    if (c === "ASSET TAGS") return "ASSET_TAGS";
    if (c === "RESULTS") return "RESULTS";
    return null;
  };

  const ensureReport = async () => {
    if (reportId) return;
    const titleRow = preamble[0] || [];
    const companyRow = preamble[1] || [];
    const contactRow = preamble[2] || [];
    const report = await prisma.complianceReport.create({
      data: {
        fileName,
        os,
        title: titleRow[0] || null,
        generatedAt: parseQDate(titleRow[1]),
        companyName: companyRow[0] || null,
        contactName: contactRow[0] || null,
        contactLogin: contactRow[1] || null,
      },
      select: { id: true },
    });
    reportId = report.id;
  };

  // Flush the buffered small sections once, right before results start streaming.
  const flushSmallSections = async () => {
    if (smallSectionsFlushed) return;
    await ensureReport();
    const rid = reportId!;
    if (summaries.length) {
      await prisma.policySummary.createMany({ data: summaries.map((s) => ({ ...s, reportId: rid })) });
    }
    if (controlStats.length) {
      await prisma.controlStatistic.createMany({ data: controlStats.map((c) => ({ ...c, reportId: rid })) });
    }
    if (hostStats.length) {
      await prisma.hostStatistic.createMany({
        data: hostStats.map((h) => ({ ...h, reportId: rid, assetTags: assetTagsByIp.get(h.ipAddress) ?? null })),
      });
    }
    smallSectionsFlushed = true;
  };

  const flushResults = async () => {
    if (!resultBatch.length) return;
    const rid = reportId!;
    const batch = resultBatch.map((r) => ({ ...r, reportId: rid }));
    resultBatch = [];
    await prisma.complianceResult.createMany({ data: batch });
  };

  input.pipe(parser);

  for await (const row of parser as AsyncIterable<string[]>) {
    // Section transition?
    const m = marker(row[0]);
    if (m) {
      section = m;
      expectHeader = m !== "ASSET_TAGS"; // ASSET TAGS rows have no column header
      if (m === "RESULTS") await flushSmallSections();
      else if (m === "SUMMARY") await ensureReport();
      continue;
    }
    if (expectHeader) {
      expectHeader = false; // consume the column-header row
      continue;
    }

    switch (section) {
      case "PREAMBLE":
        preamble.push(row);
        break;

      case "SUMMARY": {
        const passed = parseCountPct(row[13]);
        const failures = parseCountPct(row[14]);
        summaries.push({
          policyId: row[0] || "",
          policyTitle: row[1] || "",
          policyLocking: row[2] || null,
          policyModified: parseQDate(row[3]),
          policyLastEvaluated: parseQDate(row[4]),
          assetGroups: row[5] || null,
          ips: row[6] || null,
          assetTags: row[7] || null,
          pcAgentIps: row[8] || null,
          technologies: row[9] || null,
          controls: toInt(row[10]),
          assets: toInt(row[11]),
          controlInstances: toInt(row[12]),
          passed: passed.count,
          passedPct: passed.pct,
          failures: failures.count,
          failuresPct: failures.pct,
          error: toInt(row[15]),
          approvedExceptions: toInt(row[16]),
          pendingExceptions: toInt(row[17]),
        });
        break;
      }

      case "CONTROL_STATS": {
        const p = parsePctOf(row[6]);
        controlStats.push({
          orderNo: row[0] || "",
          controlId: toInt(row[1]) ?? 0,
          deprecated: toBool(row[2]),
          statement: row[3] || "",
          criticalityLabel: row[4] || null,
          criticalityValue: toInt(row[5]),
          percentage: p.pct,
          passedHosts: p.passed,
          totalHosts: p.total,
        });
        break;
      }

      case "HOST_STATS": {
        const p = parsePctOf(row[6]);
        hostStats.push({
          ipAddress: row[0] || "",
          trackingMethod: row[1] || null,
          dnsName: row[2] || null,
          netbiosName: row[3] || null,
          operatingSystem: row[4] || null,
          lastScanDate: parseQDate(row[5]),
          percentage: p.pct,
          passedControls: p.passed,
          totalControls: p.total,
          qualysHostId: row[7] || null,
          hostId: row[8] || null,
        });
        break;
      }

      case "ASSET_TAGS": {
        // row[0] = IP, the rest is the (mis-quoted) comma-split tag list.
        const ip = (row[0] || "").trim();
        const tags = row
          .slice(1)
          .join(", ")
          .replace(/"/g, "")
          .trim();
        if (ip) assetTagsByIp.set(ip, tags);
        break;
      }

      case "RESULTS": {
        await flushSmallSections(); // safety: results may appear with no small sections
        resultBatch.push({
          hostIp: row[0] || null,
          dnsHostname: row[1] || null,
          netbiosHostname: row[2] || null,
          trackingMethod: row[3] || null,
          operatingSystem: row[4] || null,
          network: row[5] || null,
          lastScanDate: parseQDate(row[6]),
          evaluationDate: parseQDate(row[7]),
          controlId: toInt(row[8]),
          controlReferences: row[9] || null,
          technology: row[10] || null,
          control: row[11] || null,
          criticalityLabel: row[12] || null,
          criticalityValue: toInt(row[13]),
          instance: row[14] || null,
          rationale: row[15] || null,
          status: row[16] || null,
          remediation: row[17] || null,
          deprecated: toBool(row[18]),
          evidence: row[19] || null,
          exceptionAssignee: row[20] || null,
          exceptionStatus: row[21] || null,
          exceptionEndDate: parseQDate(row[22]),
          exceptionCreator: row[23] || null,
          exceptionCreatedDate: parseQDate(row[24]),
          exceptionModifier: row[25] || null,
          exceptionModifiedDate: parseQDate(row[26]),
          causeOfFailure: row[27] || null,
          qualysHostId: row[28] || null,
          previousStatus: row[29] || null,
          firstFailDate: parseQDate(row[30]),
          lastFailDate: parseQDate(row[31]),
          firstPassDate: parseQDate(row[32]),
          lastPassDate: parseQDate(row[33]),
        });
        resultCount++;
        if (resultBatch.length >= RESULTS_BATCH) await flushResults();
        break;
      }
    }
  }

  // Drain anything left (handles files with no RESULTS section too).
  await flushSmallSections();
  await flushResults();

  const counts = {
    summaries: summaries.length,
    controlStats: controlStats.length,
    hostStats: hostStats.length,
    results: resultCount,
  };
  await prisma.complianceReport.update({
    where: { id: reportId! },
    data: {
      summaryCount: counts.summaries,
      controlStatCount: counts.controlStats,
      hostStatCount: counts.hostStats,
      resultCount: counts.results,
    },
  });

  return { reportId: reportId!, counts };
}
