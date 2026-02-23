#!/usr/bin/env node
import { previewUploadFromUrl } from "../src/pipeline/previewUploadFromUrl.js";
import { evaluateQcGate } from "../src/pipeline/qcGate.js";
import { runUploadFromUrl } from "../src/pipeline/runUploadFromUrl.js";

function parseArgs(argv) {
  const args = [...argv];
  const out = {
    mock: false,
    urls: [],
    previewOnly: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--mock") {
      out.mock = true;
      continue;
    }
    if (arg === "--preview-only") {
      out.previewOnly = true;
      continue;
    }
    if (arg === "--urls") {
      const next = args[i + 1] || "";
      i += 1;
      out.urls.push(...splitUrls(next));
      continue;
    }
    if (arg.startsWith("--urls=")) {
      out.urls.push(...splitUrls(arg.slice("--urls=".length)));
      continue;
    }
    if (arg.startsWith("--")) continue;
    out.urls.push(...splitUrls(arg));
  }

  out.urls = dedupe(out.urls);
  return out;
}

function splitUrls(raw) {
  return String(raw || "")
    .split(/\n|,|\s+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function dedupe(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

function pickCaseName(index) {
  return ["normal", "contaminated", "low_quality"][index] || `case_${index + 1}`;
}

function toRows(results) {
  return results.map((r) => ({
    case: r.case,
    previewOk: Boolean(r.preview?.ok),
    qcOk: Boolean(r.qc?.ok),
    uploadOk: Boolean(r.result?.ok),
    skipped: Boolean(r.result?.skipped),
    error: r.result?.error || null,
    createId: r.result?.create?.sellerProductId ?? null,
    followUpStatus: r.result?.followUp?.statusName ?? null,
  }));
}

function makeMockCase({ caseName, previewMetrics }) {
  const qc = evaluateQcGate(previewMetrics, {});
  return {
    case: caseName,
    url: null,
    preview: {
      ok: true,
      metrics: previewMetrics,
    },
    qc,
    result: {
      ok: qc.ok,
      skipped: !qc.ok,
      error: qc.ok ? null : "qc_gate_failed",
      detail: qc.ok ? null : { reasons: qc.reasons, metrics: qc.metrics },
      qc: { ok: qc.ok, metrics: qc.metrics },
      create: { sellerProductId: null },
      followUp: { statusName: null },
    },
  };
}

function mockResults() {
  return [
    makeMockCase({
      caseName: "normal",
      previewMetrics: {
        mainImageUrl: "https://img.example.com/products/123/main.jpg",
        imageCountRaw: 10,
        imageCountFiltered: 8,
        imageCountRejected: 2,
        tokenMatchRate: 0.8,
        rejectedRate: 0.2,
        hostDiversityRaw: 2,
        hostDiversityFiltered: 1,
        mainImageTokenCount: 4,
        strictMode: true,
      },
    }),
    makeMockCase({
      caseName: "contaminated",
      previewMetrics: {
        mainImageUrl: "https://img.example.com/products/123/main.jpg",
        imageCountRaw: 9,
        imageCountFiltered: 2,
        imageCountRejected: 7,
        tokenMatchRate: 0.12,
        rejectedRate: 0.78,
        hostDiversityRaw: 6,
        hostDiversityFiltered: 2,
        mainImageTokenCount: 3,
        strictMode: true,
      },
    }),
    makeMockCase({
      caseName: "low_quality",
      previewMetrics: {
        mainImageUrl: "https://img.example.com/products/987/main.jpg",
        imageCountRaw: 2,
        imageCountFiltered: 1,
        imageCountRejected: 1,
        tokenMatchRate: 0.5,
        rejectedRate: 0.5,
        hostDiversityRaw: 1,
        hostDiversityFiltered: 1,
        mainImageTokenCount: 2,
        strictMode: true,
      },
    }),
  ];
}

function getLiveCaseInputs(urls) {
  const fromEnv = splitUrls(process.env.QC_SMOKE_URLS || "");
  const merged = urls.length > 0 ? urls : fromEnv;
  return merged.slice(0, 3).map((url, idx) => ({ case: pickCaseName(idx), url }));
}

function normalizePreview(preview) {
  if (!preview?.ok) {
    return {
      ok: false,
      error: preview?.error || preview?.reason || "preview_failed",
      title: null,
      imageFingerprint: null,
      metrics: {},
    };
  }

  return {
    ok: true,
    error: null,
    title: preview?.draft?.title || null,
    imageFingerprint: preview?.preview?.imageFingerprint || null,
    metrics: {
      imageCountRaw: preview?.preview?.imageCountRaw ?? 0,
      imageCountFiltered: preview?.preview?.imageCountFiltered ?? 0,
      imageCountRejected: preview?.preview?.imageCountRejected ?? 0,
      tokenMatchRate: preview?.preview?.tokenMatchRate ?? 0,
      rejectedRate: preview?.preview?.rejectedRate ?? 0,
      hostDiversityRaw: preview?.preview?.hostDiversityRaw ?? 0,
      hostDiversityFiltered: preview?.preview?.hostDiversityFiltered ?? 0,
      mainImageTokenCount: preview?.preview?.mainImageTokenCount ?? 0,
    },
  };
}

async function runLiveCases({ urls, previewOnly }) {
  const inputs = getLiveCaseInputs(urls);
  if (inputs.length < 3) {
    throw new Error("live mode requires 3 urls. pass with --urls 'url1,url2,url3'");
  }

  const results = [];

  for (const item of inputs) {
    const settings = {
      strictImageMatch: "1",
      payloadOnly: previewOnly ? "1" : "0",
    };

    try {
      const preview = await previewUploadFromUrl(item.url, settings);
      const previewSummary = normalizePreview(preview);

      if (!preview?.ok) {
        results.push({
          case: item.case,
          url: item.url,
          preview: previewSummary,
          qc: { ok: false, reasons: [previewSummary.error], metrics: {} },
          result: {
            ok: false,
            skipped: true,
            error: previewSummary.error,
            detail: null,
            qc: { ok: false, metrics: {} },
            create: { sellerProductId: null },
            followUp: { statusName: null },
          },
        });
        continue;
      }

      const qc = evaluateQcGate(preview.preview || {}, settings);
      const runResult = await runUploadFromUrl(item.url, settings, { preview });

      results.push({
        case: item.case,
        url: item.url,
        preview: previewSummary,
        qc,
        result: {
          ok: Boolean(runResult?.ok),
          skipped: Boolean(runResult?.skipped),
          error: runResult?.error || null,
          detail: runResult?.detail || null,
          qc: {
            ok: Boolean(runResult?.qc?.ok),
            metrics: runResult?.qc?.metrics || {},
          },
          create: {
            sellerProductId: runResult?.create?.sellerProductId ?? null,
            status: runResult?.create?.status ?? null,
          },
          followUp: {
            statusName: runResult?.followUp?.statusName ?? null,
          },
        },
      });
    } catch (e) {
      results.push({
        case: item.case,
        url: item.url,
        preview: { ok: false, error: String(e?.message || e), title: null, imageFingerprint: null, metrics: {} },
        qc: { ok: false, reasons: [String(e?.message || e)], metrics: {} },
        result: {
          ok: false,
          skipped: false,
          error: String(e?.message || e),
          detail: null,
          qc: { ok: false, metrics: {} },
          create: { sellerProductId: null, status: null },
          followUp: { statusName: null },
        },
      });
    }
  }

  return results;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  let results;
  let mode;

  if (args.mock) {
    mode = "mock";
    results = mockResults();
  } else {
    mode = args.previewOnly ? "live_preview_only" : "live_create";
    results = await runLiveCases({ urls: args.urls, previewOnly: args.previewOnly });
  }

  const rows = toRows(results);
  console.table(rows);
  console.log(JSON.stringify({ ok: true, mode, results }, null, 2));
}

run().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
  process.exit(1);
});
