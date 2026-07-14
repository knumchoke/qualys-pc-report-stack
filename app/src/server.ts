import path from "path";
import fs from "fs";
import express, { Request, Response } from "express";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "./generated/prisma/client";
import { importComplianceReport } from "./complianceImport";
import {
  buildWorkbook,
  exportFileName,
  ReportNotFoundError,
  ReportMissingOsError,
} from "./scripts/export-report";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Prisma 7 connects through a driver adapter rather than a bundled engine.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

app.use(express.json());
// Control-section CSV uploads arrive as a small raw text body. Scope the text
// body parser to that route only — the compliance-report route must NOT be
// buffered (those files can exceed 100MB); it reads the raw request stream.
app.use("/api/control-sections/upload", express.text({ type: ["text/csv", "text/plain"], limit: "20mb" }));
// Serve static assets, but tell browsers to always revalidate HTML so edits to
// the pages show up on a normal refresh instead of being served from disk cache.
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    setHeaders: (res, filePath) => {
      if (/\.(html|css|js)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
    },
  }),
);

interface ControlSectionRow {
  cid: number;
  os: string;
  sectionNo: number;
  sectionName: string;
}

// Split a single CSV line into fields, honoring double-quoted values. Surrounding
// quotes are stripped, embedded "" is unescaped to ", and commas inside quotes are
// kept as part of the field (so `1,"a, b"` → ["1", "a, b"]).
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'; // escaped quote ("")
          i++;
        } else {
          inQuotes = false; // closing quote
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true; // opening quote
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

// Parse the cid-section CSV (CID,OS,section_no,section_name). The header row is
// optional. Fields may be double-quoted (quotes are stripped); a quoted
// section_name may contain commas.
function parseControlSectionCsv(text: string): ControlSectionRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const start = /^"?cid"?,/i.test(lines[0]) ? 1 : 0;
  const rows: ControlSectionRow[] = [];

  for (let i = start; i < lines.length; i++) {
    const lineNo = i + 1;
    const parts = splitCsvLine(lines[i]);
    if (parts.length < 4) {
      throw new Error(`Line ${lineNo}: expected 4 columns, got ${parts.length}`);
    }
    const cid = Number(parts[0]);
    const os = parts[1];
    const sectionNo = Number(parts[2]);
    // Re-join any trailing fields so an unquoted name with commas still works.
    const sectionName = parts.slice(3).join(",").trim();

    if (!Number.isInteger(cid)) throw new Error(`Line ${lineNo}: invalid CID "${parts[0]}"`);
    if (!os) throw new Error(`Line ${lineNo}: missing OS`);
    if (!Number.isInteger(sectionNo)) throw new Error(`Line ${lineNo}: invalid section_no "${parts[2]}"`);
    if (!sectionName) throw new Error(`Line ${lineNo}: missing section_name`);

    rows.push({ cid, os, sectionNo, sectionName });
  }
  return rows;
}

interface PlanChange {
  id: string;
  cid: number;
  os: string;
  before: { sectionNo: number; sectionName: string };
  after: { sectionNo: number; sectionName: string };
}

interface UploadPlan {
  toCreate: ControlSectionRow[];
  toUpdate: PlanChange[];
  unchanged: number;
}

// Diff the CSV rows against the current table without writing anything: classify
// each (cid, os) as a create, an update (with before/after), or unchanged.
async function computeControlSectionPlan(rows: ControlSectionRow[]): Promise<UploadPlan> {
  // De-dupe within the file (last occurrence wins).
  const byKey = new Map<string, ControlSectionRow>();
  for (const r of rows) byKey.set(`${r.cid}::${r.os}`, r);
  const unique = [...byKey.values()];

  const existing = await prisma.controlSection.findMany({
    select: { id: true, cid: true, os: true, sectionNo: true, sectionName: true },
  });
  const existingByKey = new Map<string, (typeof existing)[number]>();
  for (const e of existing) existingByKey.set(`${e.cid}::${e.os}`, e);

  const toCreate: ControlSectionRow[] = [];
  const toUpdate: PlanChange[] = [];
  let unchanged = 0;

  for (const r of unique) {
    const cur = existingByKey.get(`${r.cid}::${r.os}`);
    if (!cur) {
      toCreate.push(r);
    } else if (cur.sectionNo !== r.sectionNo || cur.sectionName !== r.sectionName) {
      toUpdate.push({
        id: cur.id,
        cid: r.cid,
        os: r.os,
        before: { sectionNo: cur.sectionNo, sectionName: cur.sectionName },
        after: { sectionNo: r.sectionNo, sectionName: r.sectionName },
      });
    } else {
      unchanged++;
    }
  }
  return { toCreate, toUpdate, unchanged };
}

// Apply a plan: bulk-insert creates, then update changed rows, in batches.
async function applyControlSectionPlan(plan: UploadPlan) {
  const BATCH = 500;

  for (let i = 0; i < plan.toCreate.length; i += BATCH) {
    await prisma.controlSection.createMany({ data: plan.toCreate.slice(i, i + BATCH) });
  }

  for (let i = 0; i < plan.toUpdate.length; i += BATCH) {
    const batch = plan.toUpdate.slice(i, i + BATCH);
    await prisma.$transaction(
      batch.map((c) =>
        prisma.controlSection.update({
          where: { id: c.id },
          data: { sectionNo: c.after.sectionNo, sectionName: c.after.sectionName },
        }),
      ),
    );
  }

  return { created: plan.toCreate.length, updated: plan.toUpdate.length };
}

// Liveness probe
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Readiness probe — checks the database connection via Prisma
app.get("/api/db-status", async (_req: Request, res: Response) => {
  try {
    const [{ version }] = await prisma.$queryRaw<{ version: string }[]>`SELECT version() AS version`;
    const visits = await prisma.visit.count();
    res.json({ db: "connected", version, visits });
  } catch (err) {
    res.status(503).json({ db: "error", message: (err as Error).message });
  }
});

// Demo info endpoint — also records the visit so the page shows live data
app.get("/api/info", async (req: Request, res: Response) => {
  let recorded = false;
  try {
    await prisma.visit.create({
      data: { path: "/", userAgent: req.get("user-agent") ?? null },
    });
    recorded = true;
  } catch {
    // DB may not be ready yet; the demo page still renders.
  }

  res.json({
    app: "qualys-app",
    env: process.env.NODE_ENV || "development",
    node: process.version,
    visitRecorded: recorded,
    time: new Date().toISOString(),
  });
});

// Upload CSV of (CID, OS) → section mappings into ControlSection.
//   ?dryRun=1 → return a preview of what would change (no writes).
//   otherwise → apply the changes and return created/updated counts.
// Up to `SAMPLE` example rows of each kind are returned so the UI can show a diff
// without shipping the entire file back.
const SAMPLE = 50;
app.post("/api/control-sections/upload", async (req: Request, res: Response) => {
  const csv = typeof req.body === "string" ? req.body : "";
  if (!csv.trim()) {
    return res.status(400).json({ error: "Empty upload — expected CSV text." });
  }

  let rows: ControlSectionRow[];
  try {
    rows = parseControlSectionCsv(csv);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  if (rows.length === 0) {
    return res.status(400).json({ error: "No data rows found in CSV." });
  }

  const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";

  try {
    const plan = await computeControlSectionPlan(rows);

    if (dryRun) {
      return res.json({
        preview: true,
        received: rows.length,
        summary: {
          create: plan.toCreate.length,
          update: plan.toUpdate.length,
          unchanged: plan.unchanged,
        },
        createSample: plan.toCreate.slice(0, SAMPLE),
        updateSample: plan.toUpdate.slice(0, SAMPLE),
      });
    }

    const result = await applyControlSectionPlan(plan);
    res.json({ ok: true, received: rows.length, unchanged: plan.unchanged, ...result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Validate and normalize a ControlSection request body.
function parseControlSectionBody(body: unknown): ControlSectionRow {
  const b = (body ?? {}) as Record<string, unknown>;
  const cid = Number(b.cid);
  const os = typeof b.os === "string" ? b.os.trim() : "";
  const sectionNo = Number(b.sectionNo);
  const sectionName = typeof b.sectionName === "string" ? b.sectionName.trim() : "";

  if (!Number.isInteger(cid)) throw new Error("cid must be an integer");
  if (!os) throw new Error("os is required");
  if (!Number.isInteger(sectionNo)) throw new Error("sectionNo must be an integer");
  if (!sectionName) throw new Error("sectionName is required");

  return { cid, os, sectionNo, sectionName };
}

// True when a Prisma error is a unique-constraint violation (duplicate cid+os).
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// List with search (q) + pagination.
app.get("/api/control-sections", async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  const where: Prisma.ControlSectionWhereInput = q
    ? {
        OR: [
          { os: { contains: q, mode: "insensitive" } },
          { sectionName: { contains: q, mode: "insensitive" } },
          ...(Number.isInteger(Number(q)) ? [{ cid: Number(q) }, { sectionNo: Number(q) }] : []),
        ],
      }
    : {};

  try {
    const [data, total] = await Promise.all([
      prisma.controlSection.findMany({
        where,
        orderBy: [{ cid: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.controlSection.count({ where }),
    ]);
    res.json({ data, total, page, pageSize });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Distinct OS keys that have section mappings — used to populate the compliance
// upload form's mandatory OS picker.
app.get("/api/control-sections/os", async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.controlSection.findMany({
      distinct: ["os"],
      select: { os: true },
      orderBy: { os: "asc" },
    });
    res.json({ data: rows.map((r) => r.os) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Create.
app.post("/api/control-sections", async (req: Request, res: Response) => {
  let row: ControlSectionRow;
  try {
    row = parseControlSectionBody(req.body);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  try {
    const created = await prisma.controlSection.create({ data: row });
    res.status(201).json(created);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `A record for CID ${row.cid} / ${row.os} already exists.` });
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// Update.
app.put("/api/control-sections/:id", async (req: Request, res: Response) => {
  let row: ControlSectionRow;
  try {
    row = parseControlSectionBody(req.body);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  try {
    const updated = await prisma.controlSection.update({
      where: { id: req.params.id },
      data: row,
    });
    res.json(updated);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Record not found." });
    }
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `A record for CID ${row.cid} / ${row.os} already exists.` });
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// Delete.
app.delete("/api/control-sections/:id", async (req: Request, res: Response) => {
  try {
    await prisma.controlSection.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Record not found." });
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Qualys compliance reports
// ---------------------------------------------------------------------------

// Stream-upload a (potentially very large) compliance report CSV. The raw request
// body IS the file; pass the original name via ?fileName= and the OS key via ?os=.
// The OS is mandatory and must be one known to ControlSection so the report's
// results can later be mapped to section names. Nothing is buffered.
app.post("/api/compliance-reports/upload", async (req: Request, res: Response) => {
  const fileName =
    (typeof req.query.fileName === "string" && req.query.fileName.trim()) || "upload.csv";
  const os = typeof req.query.os === "string" ? req.query.os.trim() : "";

  if (!os) {
    return res.status(400).json({ error: "An OS must be selected for the report." });
  }
  // Validate against known ControlSection OS keys before consuming the stream.
  const known = await prisma.controlSection.findFirst({ where: { os }, select: { os: true } });
  if (!known) {
    return res.status(400).json({ error: `Unknown OS "${os}" — no ControlSection mapping exists for it.` });
  }

  try {
    const result = await importComplianceReport(prisma, fileName, os, req);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// List uploaded reports (metadata + row counts; no heavy result rows),
// paginated with search over file name / OS / policy title.
app.get("/api/compliance-reports", async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  const where: Prisma.ComplianceReportWhereInput = {};
  if (q) {
    where.OR = [
      { fileName: { contains: q, mode: "insensitive" } },
      { os: { contains: q, mode: "insensitive" } },
      { title: { contains: q, mode: "insensitive" } },
    ];
  }

  try {
    const [data, total] = await Promise.all([
      prisma.complianceReport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          fileName: true,
          os: true,
          title: true,
          generatedAt: true,
          summaryCount: true,
          controlStatCount: true,
          hostStatCount: true,
          resultCount: true,
          createdAt: true,
          summaries: { select: { assetTags: true } },
        },
      }),
      prisma.complianceReport.count({ where }),
    ]);
    res.json({ data, total, page, pageSize });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Report detail: metadata + summary, plus aggregates used by the page —
// failed-results-by-criticality and the distinct criticality labels (for filters).
// Host stats and results have their own paginated endpoints.
app.get("/api/compliance-reports/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  try {
    const report = await prisma.complianceReport.findUnique({
      where: { id },
      include: { summaries: true },
    });
    if (!report) return res.status(404).json({ error: "Report not found." });

    const [failedGroups, allGroups] = await Promise.all([
      prisma.complianceResult.groupBy({
        by: ["criticalityLabel", "criticalityValue"],
        where: { reportId: id, status: "Failed" },
        _count: { _all: true },
        orderBy: { criticalityValue: "desc" },
      }),
      prisma.complianceResult.groupBy({
        by: ["criticalityLabel", "criticalityValue"],
        where: { reportId: id },
        _count: { _all: true },
        orderBy: { criticalityValue: "desc" },
      }),
    ]);

    res.json({
      ...report,
      failedByCriticality: failedGroups.map((g) => ({
        label: g.criticalityLabel,
        value: g.criticalityValue,
        count: g._count._all,
      })),
      criticalityLabels: allGroups.map((g) => g.criticalityLabel).filter((l): l is string => !!l),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Paginated host statistics for one report, with search (IP / DNS / OS).
app.get("/api/compliance-reports/:id/hosts", async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  const where: Prisma.HostStatisticWhereInput = { reportId: req.params.id };
  if (q) {
    where.OR = [
      { ipAddress: { contains: q, mode: "insensitive" } },
      { dnsName: { contains: q, mode: "insensitive" } },
      { operatingSystem: { contains: q, mode: "insensitive" } },
    ];
  }

  try {
    const [data, total] = await Promise.all([
      prisma.hostStatistic.findMany({
        where,
        orderBy: { ipAddress: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.hostStatistic.count({ where }),
    ]);
    res.json({ data, total, page, pageSize });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Paginated results for one report, with status filter + search. Only list-friendly
// columns are selected (the big evidence/remediation text is fetched per-row below).
app.get("/api/compliance-reports/:id/results", async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const criticality = typeof req.query.criticality === "string" ? req.query.criticality.trim() : "";
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  const where: Prisma.ComplianceResultWhereInput = { reportId: req.params.id };
  if (status) where.status = status;
  if (criticality) where.criticalityLabel = criticality;
  if (q) {
    where.OR = [
      { hostIp: { contains: q, mode: "insensitive" } },
      { control: { contains: q, mode: "insensitive" } },
      ...(Number.isInteger(Number(q)) ? [{ controlId: Number(q) }] : []),
    ];
  }

  try {
    const [data, total] = await Promise.all([
      prisma.complianceResult.findMany({
        where,
        orderBy: [{ hostIp: "asc" }, { controlId: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          hostIp: true,
          controlId: true,
          control: true,
          technology: true,
          criticalityLabel: true,
          status: true,
        },
      }),
      prisma.complianceResult.count({ where }),
    ]);
    res.json({ data, total, page, pageSize });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// A single result row in full (evidence / remediation / rationale).
app.get("/api/compliance-results/:id", async (req: Request, res: Response) => {
  try {
    const row = await prisma.complianceResult.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: "Result not found." });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Delete a report and all its sections (cascades).
app.delete("/api/compliance-reports/:id", async (req: Request, res: Response) => {
  try {
    await prisma.complianceReport.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Report not found." });
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// Failed findings grouped by control for one report, with optional criticality filter, text search,
// and pagination. Returns { data, total, page, pageSize } like the other paginated endpoints.
app.get("/api/compliance-reports/:id/findings-by-control", async (req: Request, res: Response) => {
  const id = req.params.id;
  const page     = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
  const criticality = typeof req.query.criticality === "string" ? req.query.criticality.trim() : "";
  const q           = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const offset      = (page - 1) * pageSize;

  try {
    const report = await prisma.complianceReport.findUnique({ where: { id }, select: { id: true } });
    if (!report) return res.status(404).json({ error: "Report not found." });

    type FindingRow = {
      control_id: number;
      control: string;
      criticality_label: string | null;
      criticality_value: number | null;
      count: bigint;
      total_count: bigint;
    };

    const critClause = criticality ? Prisma.sql`AND criticality_label = ${criticality}` : Prisma.empty;
    const qLike = `%${q}%`;
    const searchClause = q
      ? Prisma.sql`AND (control ILIKE ${qLike} OR CAST(control_id AS TEXT) ILIKE ${qLike})`
      : Prisma.empty;

    const rows = await prisma.$queryRaw<FindingRow[]>(Prisma.sql`
      WITH grp AS (
        SELECT control_id, control, criticality_label, criticality_value, COUNT(*) AS count
        FROM compliance_results
        WHERE report_id = ${id}::uuid AND status = 'Failed'
        ${critClause}
        ${searchClause}
        GROUP BY control_id, control, criticality_label, criticality_value
      )
      SELECT *, COUNT(*) OVER() AS total_count
      FROM grp
      ORDER BY count DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `);

    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;

    res.json({
      data: rows.map((r) => ({
        controlId: r.control_id,
        control: r.control,
        criticalityLabel: r.criticality_label,
        criticalityValue: r.criticality_value,
        count: Number(r.count),
      })),
      total,
      page,
      pageSize,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Executive summary for one report — sections (via raw JOIN), criticality split, and HIGH findings.
app.get("/api/compliance-reports/:id/executive", async (req: Request, res: Response) => {
  const id = req.params.id;
  try {
    const report = await prisma.complianceReport.findUnique({
      where: { id },
      include: { summaries: true },
    });
    if (!report) return res.status(404).json({ error: "Report not found." });

    const os = report.os;
    if (!os) {
      return res.status(400).json({
        error: "Report has no OS — re-upload with an OS to use the executive view.",
      });
    }

    const s = report.summaries[0];

    // Section pass/fail counts: JOIN requires raw SQL (no Prisma relation between models).
    const sections = await prisma.$queryRaw<
      { section_no: number; section_name: string; passed: bigint; failed: bigint; total: bigint }[]
    >`
      SELECT cs.section_no, cs.section_name,
        COUNT(*) FILTER (WHERE cr.status = 'Passed') AS passed,
        COUNT(*) FILTER (WHERE cr.status = 'Failed') AS failed,
        COUNT(*) AS total
      FROM compliance_results cr
      JOIN control_sections cs ON cs.cid = cr.control_id AND cs.os = ${os}
      WHERE cr.report_id = ${id}::uuid
      GROUP BY cs.section_no, cs.section_name
      ORDER BY cs.section_no
    `;

    // Criticality breakdown with passed + failed split.
    const critRaw = await prisma.$queryRaw<
      { criticality_label: string; criticality_value: number; passed: bigint; failed: bigint }[]
    >`
      SELECT criticality_label, criticality_value,
        COUNT(*) FILTER (WHERE status = 'Passed') AS passed,
        COUNT(*) FILTER (WHERE status = 'Failed') AS failed
      FROM compliance_results
      WHERE report_id = ${id}::uuid AND criticality_label IS NOT NULL
      GROUP BY criticality_label, criticality_value
      ORDER BY criticality_value DESC
    `;

    // All failed findings grouped by (criticality tier, control) — used for prioritization slides.
    const prioritizationRaw = await prisma.$queryRaw<
      { criticality_label: string; criticality_value: number; control_id: number; control: string; count: bigint }[]
    >`
      SELECT criticality_label, criticality_value, control_id, control, COUNT(*) AS count
      FROM compliance_results
      WHERE report_id = ${id}::uuid AND status = 'Failed' AND criticality_label IS NOT NULL
      GROUP BY criticality_label, criticality_value, control_id, control
      ORDER BY criticality_value DESC, count DESC
    `;

    // Group rows into per-tier buckets (keyed by criticalityValue).
    type PrioritizationTier = {
      label: string;
      value: number;
      total: number;
      items: { controlId: number; control: string; count: number }[];
    };
    const tierMap = new Map<number, PrioritizationTier>();
    for (const r of prioritizationRaw) {
      if (!tierMap.has(r.criticality_value)) {
        tierMap.set(r.criticality_value, { label: r.criticality_label, value: r.criticality_value, total: 0, items: [] });
      }
      const tier = tierMap.get(r.criticality_value)!;
      tier.items.push({ controlId: r.control_id, control: r.control, count: Number(r.count) });
      tier.total += Number(r.count);
    }
    const prioritization = [...tierMap.values()].sort((a, b) => b.value - a.value);

    // Keep highFindings for backward compat — it's the HIGH tier from prioritization.
    const highTier = tierMap.get(5);

    res.json({
      report: {
        os: report.os,
        title: report.title,
        generatedAt: report.generatedAt,
        serverCount: report.hostStatCount,
        companyName: report.companyName,
      },
      overall: {
        passed: s?.passed ?? null,
        failed: s?.failures ?? null,
        passedPct: s?.passedPct ?? null,
        failedPct: s?.failuresPct ?? null,
      },
      sections: sections.map((r) => {
        const total = Number(r.total);
        const passed = Number(r.passed);
        return {
          sectionNo: r.section_no,
          sectionName: r.section_name,
          passed,
          failed: Number(r.failed),
          total,
          passedPct: total > 0 ? Math.round((passed / total) * 100) : 0,
        };
      }),
      criticality: critRaw.map((r) => ({
        label: r.criticality_label,
        value: r.criticality_value,
        passed: Number(r.passed),
        failed: Number(r.failed),
      })),
      prioritization,
      highFindings: {
        total: highTier?.total ?? 0,
        items: highTier?.items ?? [],
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Export one report as a multi-tab .xlsx workbook (Summary + charts, FirstScan,
// Priority, _raw, CID). Streams the file to the client — no server-side copy is
// written (the CLI script in scripts/export-report.ts keeps that dev/review path).
//   404 if the report doesn't exist; 400 if it has no OS (the section join needs one).
app.get("/api/compliance-reports/:id/export.xlsx", async (req: Request, res: Response) => {
  const id = req.params.id;
  try {
    // Fetch the name fields up front so the filename is right even on success.
    const report = await prisma.complianceReport.findUnique({
      where: { id },
      select: { fileName: true, title: true, os: true },
    });
    if (!report) return res.status(404).json({ error: "Report not found." });

    // buildWorkbook streams the workbook to a temp file (bounded memory, even on
    // very large reports) and returns its path; we stream it to the client and
    // delete it afterwards.
    const tmpPath = await buildWorkbook(prisma, id);
    const fileName = exportFileName(id, report);
    const cleanup = () => fs.unlink(tmpPath, () => {});

    const stat = fs.statSync(tmpPath);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", stat.size);

    const stream = fs.createReadStream(tmpPath);
    stream.on("error", () => {
      cleanup();
      if (!res.headersSent) res.status(500).end();
    });
    res.on("close", cleanup);
    stream.pipe(res);
  } catch (err) {
    if (err instanceof ReportNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof ReportMissingOsError) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`qualys-app listening on port ${PORT}`);
});
