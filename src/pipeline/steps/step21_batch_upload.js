import fs from "fs";
import path from "path";

import { COUPANG_VENDOR_ID, COUPANG_VENDOR_USER_ID, IMAGE_PROXY_BASE } from "../../config/env.js";
import { classifyUrl } from "../../utils/urlFilter.js";
import { parseProductFromDomaeqq } from "../../sources/domaeqq/parseProductFromDomaeqq.js";
import { buildSellerProductBody } from "../../coupang/builders/buildSellerProductBody.js";
import { createSellerProduct } from "../../coupang/api/createSellerProduct.js";
import { prepareProxyUrl } from "../../utils/imageProxy.js";
import { extractImageUrls, buildImageOnlyHtmlFromUrls, filterDomeggookUrls } from "../../utils/contentImages.js";

const OUTBOUND_SHIPPING_PLACE_CODE = "24093380";
const DISPLAY_CATEGORY_CODE = 77723;

const URLS_FILE = path.resolve(process.cwd(), "urls.txt");
const OUT_DIR = path.resolve(process.cwd(), "out");
const RESULT_JSONL = path.join(OUT_DIR, "upload_results.jsonl");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readUrls() {
  if (!fs.existsSync(URLS_FILE)) throw new Error("urls.txt not found at project root");
  const raw = fs.readFileSync(URLS_FILE, "utf-8");
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

function appendJsonl(obj) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(RESULT_JSONL, JSON.stringify(obj) + "\n");
}

async function uploadOne(line) {
  const parts = String(line).split("|");
  const maybeCode = parts.length > 1 ? parts[0].trim() : null;
  const url = parts.length > 1 ? parts.slice(1).join("|").trim() : String(line).trim();

  const startedAt = new Date().toISOString();
  const c = classifyUrl(url);

  if (!c.ok) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      url,
      ok: false,
      skipped: true,
      skipReason: c.reason,
      sellerProductId: null,
      responseCode: "SKIPPED",
      message: c.reason,
    };
  }

  try {
    const draft = await parseProductFromDomaeqq(c.url);

    const imageForCoupang = await prepareProxyUrl(draft.imageUrl, IMAGE_PROXY_BASE, draft.sourceUrl);
    const contentImages = filterDomeggookUrls(extractImageUrls(draft.contentText));
    const settled = await Promise.allSettled(
      contentImages.map((u) => prepareProxyUrl(u, IMAGE_PROXY_BASE, draft.sourceUrl)),
    );
    const proxiedContentUrls = settled
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);
    const contentHtml = buildImageOnlyHtmlFromUrls(proxiedContentUrls) || draft.contentText;

    const body = buildSellerProductBody({
      vendorId: COUPANG_VENDOR_ID,
      vendorUserId: COUPANG_VENDOR_USER_ID,
      outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE,
      displayCategoryCode: (maybeCode ? Number(maybeCode) : DISPLAY_CATEGORY_CODE),
      sellerProductName: draft.title,
      imageUrl: imageForCoupang,
      price: draft.price,
      stock: 10,
      contentText: contentHtml,
    });

    const res = await createSellerProduct({ vendorId: COUPANG_VENDOR_ID, body });
    const bodyObj = typeof res.body === "string" ? JSON.parse(res.body) : res.body;

    const ok = bodyObj?.code === "SUCCESS";
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      url: c.url,
      ok,
      skipped: false,
      sellerProductId: bodyObj?.data ?? null,
      responseCode: bodyObj?.code,
      message: bodyObj?.message,
    };
  } catch (e) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      url: c.url,
      ok: false,
      skipped: false,
      sellerProductId: null,
      responseCode: "EXCEPTION",
      message: String(e?.message || e),
    };
  }
}

(async () => {
  const urls = readUrls();
  console.log("URL COUNT:", urls.length);
  console.log("RESULT FILE:", RESULT_JSONL);

  const delayMs = Number(process.env.BATCH_DELAY_MS || 3000);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log("\n[" + (i + 1) + "/" + urls.length + "]", url);

    const result = await uploadOne(url);
    appendJsonl(result);

    if (result.skipped) {
      console.log("-> SKIPPED:", result.skipReason);
    } else {
      console.log("-> ok:", result.ok, "sellerProductId:", result.sellerProductId);
      if (!result.ok) console.log("-> message:", result.message);
    }

    if (i < urls.length - 1) await sleep(delayMs);
  }

  console.log("\nDONE. results saved to:", RESULT_JSONL);
})();
