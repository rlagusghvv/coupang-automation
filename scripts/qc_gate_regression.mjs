#!/usr/bin/env node
import assert from "node:assert/strict";
import { runUploadFromUrl } from "../src/pipeline/runUploadFromUrl.js";

async function main() {
  let createCalls = 0;

  const fakePreview = {
    ok: true,
    draft: {
      sourceUrl: "https://domeggook.com/12345678?from=lstBiz",
      title: "qc regression test item",
      price: 10000,
      imageUrl: "https://img.example.com/test/main.jpg",
      contentText: "",
      categoryText: "",
      options: [],
    },
    preview: {
      mainImageUrl: "https://img.example.com/test/main.jpg",
      imageCountRaw: 10,
      imageCountFiltered: 0,
      imageCountRejected: 10,
      tokenMatchRate: 0.01,
      rejectedRate: 0.99,
      hostDiversityRaw: 7,
      hostDiversityFiltered: 0,
      mainImageTokenCount: 2,
      strictMode: true,
      contentImagesFiltered: [],
      imageFingerprint: "regression_fp",
    },
  };

  const result = await runUploadFromUrl(
    "https://domeggook.com/12345678?from=lstBiz",
    {},
    {
      preview: fakePreview,
      createSellerProductFn: async () => {
        createCalls += 1;
        return { status: 200, body: JSON.stringify({ code: "SUCCESS", data: 1 }) };
      },
    },
  );

  assert.equal(result.ok, false, "qc fail must return ok=false");
  assert.equal(result.error, "qc_gate_failed", "qc fail must return qc_gate_failed error");
  assert.equal(createCalls, 0, "createSellerProduct must never be called on qc_gate_failed");
  assert.equal(result.create?.sellerProductId ?? null, null, "sellerProductId must be null on qc fail");
  assert.equal(result.followUp?.statusName ?? null, null, "followUp.statusName must be null on qc fail");

  console.log(
    JSON.stringify(
      {
        ok: true,
        test: "qc_gate_failed_blocks_create",
        createCalls,
        result: {
          ok: result.ok,
          error: result.error,
          detail: result.detail,
          qc: result.qc,
          create: result.create,
          followUp: result.followUp,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(
    JSON.stringify({ ok: false, test: "qc_gate_failed_blocks_create", error: String(e?.message || e) }, null, 2),
  );
  process.exit(1);
});
