#!/usr/bin/env node
import assert from "node:assert/strict";
import { previewUploadFromUrl } from "../src/pipeline/previewUploadFromUrl.js";

const URL = "https://domeggook.com/58965806";

async function main() {
  const res = await previewUploadFromUrl(URL, { strictImageMatch: "1" });
  assert.equal(Boolean(res?.ok), true, "preview must succeed");

  const preview = res.preview || {};
  const filtered = Array.isArray(preview.contentImagesFiltered)
    ? preview.contentImagesFiltered
    : [];

  const hasThumb = filtered.some((u) => /(?:^|[\/_-])stt_\d+\./i.test(String(u || "")));
  assert.equal(hasThumb, false, "filtered detail images must not include stt thumbnails");

  assert.equal(filtered.length, 4, `detail image count must be exactly 4 for ${URL}`);

  const totalUploadImages = 1 + filtered.length; // main + detail
  assert.equal(totalUploadImages, 5, "main + detail must be exactly 5 images");

  console.log(
    JSON.stringify(
      {
        ok: true,
        test: "product_58965806_regression",
        url: URL,
        title: res?.draft?.title || "",
        mainImage: res?.draft?.imageUrl || "",
        detailImages: filtered,
        metrics: {
          imageCountRaw: preview.imageCountRaw,
          imageCountFiltered: preview.imageCountFiltered,
          tokenMatchRate: preview.tokenMatchRate,
          pathAllowRateRaw: preview.pathAllowRateRaw,
          pathBlockedRateRaw: preview.pathBlockedRateRaw,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        test: "product_58965806_regression",
        url: URL,
        error: String(e?.message || e),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
