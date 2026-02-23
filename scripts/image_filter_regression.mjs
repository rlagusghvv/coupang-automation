#!/usr/bin/env node
import assert from "node:assert/strict";
import { analyzeSameProductImages } from "../src/pipeline/previewUploadFromUrl.js";

function run() {
  const sourceUrl = "https://domeggook.com/12345678?from=lstBiz";
  const mainImageUrl = "https://img.domeggook.com/upload/item/2026/01/01/main_12345.jpg";
  const contentImageUrls = [
    "https://img.domeggook.com/upload/item/2026/01/01/detail_01.jpg",
    "https://img.domeggook.com/editor/2026/01/01/detail_02.jpg",
    "https://img.domeggook.com/image/common/logo.png",
    "https://img.domeggook.com/image/event/banner_top.jpg",
    "https://img.domeggook.com/sns/facebook_share_btn.png",
    "https://cdn.example.com/assets/icon_kakao.png",
  ];

  const analyzed = analyzeSameProductImages({
    sourceUrl,
    mainImageUrl,
    contentImageUrls,
    strict: true,
  });

  const kept = analyzed.filteredImageUrls || [];
  const rejected = analyzed.rejectedImages || [];

  assert.equal(kept.length, 2, "strict filter must keep only detail-like assets");
  assert.ok(
    kept.every((u) => /\/upload\/item\/|\/editor\//i.test(u)),
    "kept images must be from detail-like allow paths",
  );

  const blocked = rejected.filter((r) => {
    const reason = String(r?.reason || "");
    return reason.includes("path_blocked") || reason.includes("non_product_asset");
  });
  assert.ok(blocked.length >= 3, "must block common/event/sns/icon assets by path rule");

  assert.ok(analyzed.metrics.pathBlockedCountRaw >= 3, "pathBlockedCountRaw must reflect blocked assets");
  assert.ok(analyzed.metrics.pathAllowCountRaw >= 2, "pathAllowCountRaw must reflect allow-path assets");

  console.log(
    JSON.stringify(
      {
        ok: true,
        test: "image_filter_regression",
        keptCount: kept.length,
        blockedCount: blocked.length,
        metrics: analyzed.metrics,
      },
      null,
      2,
    ),
  );
}

try {
  run();
} catch (e) {
  console.error(JSON.stringify({ ok: false, test: "image_filter_regression", error: String(e?.message || e) }, null, 2));
  process.exit(1);
}
