import { NextResponse } from "next/server";

type BatchItem = {
  candidateId: string;
  title: string;
  sourceUrl?: string;
};

type Body = {
  items?: BatchItem[];
  // client-generated idempotency key (optional in MVP)
  idempotencyKey?: string;
};

// In-memory idempotency map (MVP). For production: persist to DB/Redis.
const IDEMPOTENCY: Map<string, string> =
  (globalThis as any).__CE_BATCH_IDEMPOTENCY__ || new Map();
(globalThis as any).__CE_BATCH_IDEMPOTENCY__ = IDEMPOTENCY;

type BatchResultItem = {
  candidateId: string;
  ok: boolean;
  message: string;
  uploadedId?: string;
};

type BatchJob = {
  jobId: string;
  status: "queued" | "running" | "done";
  startedAt: string;
  finishedAt?: string;
  total: number;
  processed: number;
  ok: number;
  failed: number;
  results: BatchResultItem[];
};

// In-memory job store (MVP). For production: persist to DB/Redis.
const JOBS: Map<string, BatchJob> = (globalThis as any).__CE_BATCH_JOBS__ || new Map();
(globalThis as any).__CE_BATCH_JOBS__ = JOBS;

function isValidItem(x: any): x is BatchItem {
  return (
    x &&
    typeof x.candidateId === "string" &&
    x.candidateId.trim().length > 0 &&
    typeof x.title === "string" &&
    x.title.trim().length > 0
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function newJobId() {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function runJob(jobId: string, items: BatchItem[]) {
  const job = JOBS.get(jobId);
  if (!job) return;

  job.status = "running";

  for (const raw of items) {
    if (!isValidItem(raw)) {
      const candidateId =
        raw && typeof (raw as any).candidateId === "string" ? (raw as any).candidateId : "unknown";
      job.results.push({ candidateId, ok: false, message: "Invalid item payload." });
      job.processed += 1;
      job.failed += 1;
      continue;
    }

    // Simulate variable latency.
    await sleep(80 + Math.round(Math.random() * 140));

    // Simulate occasional failures.
    const fail = raw.title.toLowerCase().includes("fail") || Math.random() < 0.08;
    if (fail) {
      job.results.push({
        candidateId: raw.candidateId,
        ok: false,
        message: "업로드 실패(시뮬레이션). 재시도하세요.",
      });
      job.processed += 1;
      job.failed += 1;
      continue;
    }

    job.results.push({
      candidateId: raw.candidateId,
      ok: true,
      message: "업로드 완료",
      uploadedId: `upl_${raw.candidateId}`,
    });
    job.processed += 1;
    job.ok += 1;
  }

  job.status = "done";
  job.finishedAt = new Date().toISOString();
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId") || "";
  if (!jobId) {
    return NextResponse.json({ ok: false, message: "Missing jobId" }, { status: 400 });
  }

  const job = JOBS.get(jobId);
  if (!job) {
    return NextResponse.json({ ok: false, message: "Job not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, job });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null;
  const items = Array.isArray(body?.items) ? body!.items : [];

  if (!items.length) {
    return NextResponse.json(
      { ok: false, message: "업로드할 상품이 없습니다." },
      { status: 400 },
    );
  }

  // Guardrails: keep payload small in MVP.
  if (items.length > 25) {
    return NextResponse.json(
      {
        ok: false,
        message: "한 번에 업로드할 수 있는 상품 수를 초과했습니다. (최대 25개)",
      },
      { status: 413 },
    );
  }

  const idemKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (idemKey) {
    const existingJobId = IDEMPOTENCY.get(idemKey);
    if (existingJobId && JOBS.has(existingJobId)) {
      return NextResponse.json({ ok: true, jobId: existingJobId, reused: true });
    }
  }

  const jobId = newJobId();
  const startedAt = new Date().toISOString();
  const job: BatchJob = {
    jobId,
    status: "queued",
    startedAt,
    total: items.length,
    processed: 0,
    ok: 0,
    failed: 0,
    results: [],
  };
  JOBS.set(jobId, job);
  if (idemKey) IDEMPOTENCY.set(idemKey, jobId);

  // Fire-and-forget async processing.
  void runJob(jobId, items as BatchItem[]);

  return NextResponse.json({ ok: true, jobId });
}
