#!/usr/bin/env node
import { previewUploadFromUrl } from "../src/pipeline/previewUploadFromUrl.js";
import { evaluateQcGate } from "../src/pipeline/qcGate.js";

function parseArgs(argv) {
  const args = [...argv];
  const mock = args.includes("--mock");
  const urls = args.filter((a) => !a.startsWith("--"));
  return { mock, urls };
}

function toRows(results) {
  return results.map((r) => ({
    case: r.case,
    ok: Boolean(r.qc?.ok),
    raw: r.metrics?.imageCountRaw ?? null,
    kept: r.metrics?.imageCountFiltered ?? null,
    tokenMatchRate: r.metrics?.tokenMatchRate ?? null,
    rejectedRate: r.metrics?.rejectedRate ?? null,
    reasonCount: Array.isArray(r.qc?.reasons) ? r.qc.reasons.length : 0,
    error: r.error || null,
  }));
}

function mockResults() {
  const fixtureCases = [
    {
      case: "normal",
      preview: {
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
      gate: {},
    },
    {
      case: "contaminated",
      preview: {
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
      gate: {},
    },
    {
      case: "low_quality",
      preview: {
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
      gate: {},
    },
  ];

  return fixtureCases.map((item) => {
    const qc = evaluateQcGate(item.preview, item.gate);
    return {
      case: item.case,
      url: null,
      previewOk: true,
      qc,
      metrics: qc.metrics,
      reasons: qc.reasons,
    };
  });
}

function getCaseInputs(urls) {
  const fromEnv = String(process.env.QC_SMOKE_URLS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const merged = urls.length > 0 ? urls : fromEnv;
  const picked = [merged[0], merged[1], merged[2]];

  return [
    { case: "normal", url: picked[0] || null, gate: {} },
    { case: "contaminated", url: picked[1] || null, gate: { qcMinTokenMatchRate: 0.45 } },
    { case: "low_quality", url: picked[2] || null, gate: { qcMinFilteredImages: 5 } },
  ];
}

async function run() {
  const { mock, urls } = parseArgs(process.argv.slice(2));

  if (mock) {
    const results = mockResults();
    const rows = toRows(results);
    console.table(rows);
    console.log(JSON.stringify({ ok: true, mode: "mock", results }, null, 2));
    return;
  }

  const inputs = getCaseInputs(urls);
  const results = [];

  for (const item of inputs) {
    if (!item.url) {
      results.push({
        case: item.case,
        url: null,
        previewOk: false,
        qc: { ok: false, reasons: ["url_missing"], metrics: {} },
        metrics: {},
        error: "url_missing",
      });
      continue;
    }

    try {
      const preview = await previewUploadFromUrl(item.url, { strictImageMatch: "1" });
      if (!preview?.ok) {
        results.push({
          case: item.case,
          url: item.url,
          previewOk: false,
          qc: { ok: false, reasons: [preview?.reason || preview?.error || "preview_failed"], metrics: {} },
          metrics: {},
          error: preview?.reason || preview?.error || "preview_failed",
        });
        continue;
      }

      const qc = evaluateQcGate(preview.preview || {}, item.gate || {});
      results.push({
        case: item.case,
        url: item.url,
        previewOk: true,
        qc,
        metrics: qc.metrics,
        reasons: qc.reasons,
      });
    } catch (e) {
      results.push({
        case: item.case,
        url: item.url,
        previewOk: false,
        qc: { ok: false, reasons: [String(e?.message || e)], metrics: {} },
        metrics: {},
        error: String(e?.message || e),
      });
    }
  }

  const rows = toRows(results);
  console.table(rows);
  console.log(JSON.stringify({ ok: true, mode: "live", results }, null, 2));
}

run().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  process.exit(1);
});
