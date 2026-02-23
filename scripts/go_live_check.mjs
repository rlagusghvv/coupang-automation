#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const out = { urls: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--urls") {
      const next = argv[i + 1] || "";
      i += 1;
      out.urls = splitUrls(next);
      continue;
    }
    if (arg.startsWith("--urls=")) {
      out.urls = splitUrls(arg.slice("--urls=".length));
      continue;
    }
  }
  return out;
}

function splitUrls(raw) {
  return String(raw || "")
    .split(/\n|,|\s+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function runNodeScript(scriptPath, args = []) {
  const cmdArgs = [scriptPath, ...args];
  const r = spawnSync(process.execPath, cmdArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });

  return {
    ok: r.status === 0,
    status: r.status ?? null,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    command: `${process.execPath} ${cmdArgs.join(" ")}`,
  };
}

function extractTrailingJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const marker = '\n{\n  "ok"';
  const idx = text.lastIndexOf(marker);
  const candidate = idx >= 0 ? text.slice(idx + 1) : text;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function validateSmokeShape(json) {
  const results = Array.isArray(json?.results) ? json.results : [];
  if (results.length === 0) return { ok: false, reason: "missing_results", previewErrors: 0 };

  let previewErrors = 0;
  for (const item of results) {
    if (!item || typeof item !== "object") {
      return { ok: false, reason: "invalid_result_item", previewErrors };
    }
    if (!("preview" in item) || !("qc" in item) || !("result" in item)) {
      return { ok: false, reason: "missing_preview_qc_result_keys", previewErrors };
    }

    if (!item.preview || item.preview.ok !== true) previewErrors += 1;

    const result = item.result || {};
    if (!result.create || !("sellerProductId" in result.create)) {
      return { ok: false, reason: "missing_create_sellerProductId", previewErrors };
    }
    if (!result.followUp || !("statusName" in result.followUp)) {
      return { ok: false, reason: "missing_followUp_statusName", previewErrors };
    }
    if (!result.qc || !("ok" in result.qc) || !("metrics" in result.qc)) {
      return { ok: false, reason: "missing_result_qc_fields", previewErrors };
    }
  }

  return { ok: true, reason: null, previewErrors };
}

function printRows(rows) {
  console.table(
    rows.map((r) => ({
      check: r.check,
      status: r.status,
      note: r.note,
    })),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = [];

  const regression = runNodeScript("scripts/qc_gate_regression.mjs");
  rows.push({
    check: "qc_gate_regression",
    status: regression.ok ? "PASS" : "FAIL",
    note: regression.ok ? "qc_gate_failed blocks create call" : `exit=${regression.status}`,
  });

  const imageFilterRegression = runNodeScript("scripts/image_filter_regression.mjs");
  rows.push({
    check: "image_filter_regression",
    status: imageFilterRegression.ok ? "PASS" : "FAIL",
    note: imageFilterRegression.ok ? "deny/allow path filter works in strict mode" : `exit=${imageFilterRegression.status}`,
  });

  const smokeMock = runNodeScript("scripts/qc_gate_smoke.mjs", ["--mock"]);
  const mockJson = extractTrailingJson(smokeMock.stdout);
  const mockShape = validateSmokeShape(mockJson);
  rows.push({
    check: "qc_gate_smoke_mock",
    status: smokeMock.ok && mockShape.ok ? "PASS" : "FAIL",
    note:
      smokeMock.ok && mockShape.ok
        ? "mock 3-case format and gate output OK"
        : `exit=${smokeMock.status}, shape=${mockShape.reason || "unknown"}`,
  });

  if (args.urls.length === 3) {
    const smokeLive = runNodeScript("scripts/qc_gate_smoke.mjs", [
      "--urls",
      args.urls.join(","),
      "--preview-only",
    ]);
    const liveJson = extractTrailingJson(smokeLive.stdout);
    const liveShape = validateSmokeShape(liveJson);

    const vendorIdError =
      smokeLive.stdout.includes("vendorId required") || smokeLive.stderr.includes("vendorId required");

    const liveOk =
      smokeLive.ok &&
      liveShape.ok &&
      !vendorIdError &&
      Number(liveShape.previewErrors || 0) === 0;

    rows.push({
      check: "qc_gate_smoke_live_preview_only",
      status: liveOk ? "PASS" : "FAIL",
      note: liveOk
        ? "preview-only runs without upload-env dependency"
        : `exit=${smokeLive.status}, shape=${liveShape.reason || "unknown"}, previewErrors=${liveShape.previewErrors}, vendorIdError=${vendorIdError}`,
    });
  } else {
    rows.push({
      check: "qc_gate_smoke_live_preview_only",
      status: "SKIP",
      note: "pass --urls 'url1,url2,url3' to run live preview-only check",
    });
  }

  const hardFails = rows.filter((r) => r.status === "FAIL");
  const allPassOrSkip = hardFails.length === 0;

  printRows(rows);

  const result = {
    ok: allPassOrSkip,
    generatedAt: new Date().toISOString(),
    checks: rows,
    summary: {
      pass: rows.filter((r) => r.status === "PASS").length,
      fail: rows.filter((r) => r.status === "FAIL").length,
      skip: rows.filter((r) => r.status === "SKIP").length,
      verdict: allPassOrSkip ? "OPERABLE" : "BLOCKED",
    },
  };

  console.log(JSON.stringify(result, null, 2));
  if (!allPassOrSkip) process.exit(1);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
  process.exit(1);
});
