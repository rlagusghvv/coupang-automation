import { previewUploadFromUrl } from "../src/pipeline/previewUploadFromUrl.js";
import { parseProductFromDomaeqq } from "../src/sources/domaeqq/parseProductFromDomaeqq.js";
import { domeggookOpenApiGetItemView } from "../src/utils/domeggook_openapi.js";

function extractItemNo(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ""));
    const pathNo = String(u.pathname || "").match(/\/(\d{6,})(?:\/|$)/);
    if (pathNo && pathNo[1]) return pathNo[1];
    const qNo = String(u.searchParams.get("no") || "").trim();
    if (/^\d{6,}$/.test(qNo)) return qNo;
  } catch {}
  return "";
}

function toJsonSafe(value, maxLen = 500) {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > maxLen ? `${value.slice(0, maxLen)}...(truncated)` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((v) => toJsonSafe(v, maxLen));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 24)) {
      out[k] = toJsonSafe(v, maxLen);
    }
    return out;
  }
  return String(value);
}

function collectShippingHints(node, path = "", out = [], depth = 0) {
  if (out.length >= 200) return out;
  if (depth > 8) return out;

  const hitByPath = /(ship|deli|delivery|fee|shipping|배송|택배)/i.test(path);

  if (node == null) return out;
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    const text = String(node);
    const hitByValue = /(ship|deli|delivery|fee|shipping|배송|택배|원)/i.test(text);
    if (hitByPath || hitByValue) {
      out.push({ path, value: toJsonSafe(node) });
    }
    return out;
  }

  if (Array.isArray(node)) {
    node.slice(0, 30).forEach((v, i) => collectShippingHints(v, `${path}[${i}]`, out, depth + 1));
    return out;
  }

  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const nextPath = path ? `${path}.${k}` : k;
      collectShippingHints(v, nextPath, out, depth + 1);
      if (out.length >= 200) break;
    }
  }
  return out;
}

async function inspectOpenApi(itemNo) {
  if (!itemNo) {
    return { ok: false, reason: "item_no_missing" };
  }
  try {
    const r = await domeggookOpenApiGetItemView({
      itemNo,
      ver: "4.5",
      om: "json",
      timeoutMs: 15000,
    });
    const raw = r?.raw || {};
    const shippingHints = collectShippingHints(raw);
    return {
      ok: true,
      itemNo,
      requestUrl: r?.url || "",
      rawTopLevelKeys: Object.keys(raw || {}),
      shippingHints: shippingHints.slice(0, 80),
    };
  } catch (e) {
    return {
      ok: false,
      itemNo,
      reason: String(e?.message || e || "openapi_error"),
      details: toJsonSafe(e?.details || null),
    };
  }
}

async function main() {
  const inputUrl = String(process.argv[2] || "").trim();
  if (!inputUrl) {
    console.error("Usage: node scripts/debug_shipping_json.mjs <domeggook_url>");
    process.exit(1);
  }

  const itemNo = extractItemNo(inputUrl);
  const preview = await previewUploadFromUrl(inputUrl, {
    previewSourceMode: "auto",
    recommendationPreviewOpenApiIncludeAllImages: true,
    strictImageMatch: "1",
    maxContentImages: 80,
  });
  const full = await parseProductFromDomaeqq(inputUrl, { mode: "full" });
  const openApi = await inspectOpenApi(itemNo);

  const out = {
    ok: true,
    inputUrl,
    itemNo,
    preview: {
      draft: {
        title: preview?.draft?.title || "",
        price: preview?.draft?.price ?? null,
        shippingFee: preview?.draft?.shippingFee ?? null,
      },
      debugOpenApi: preview?.draft?.__debug?.openApi || null,
      image: {
        rawCount: Array.isArray(preview?.preview?.contentImagesRaw)
          ? preview.preview.contentImagesRaw.length
          : 0,
        filteredCount: Array.isArray(preview?.preview?.contentImagesFiltered)
          ? preview.preview.contentImagesFiltered.length
          : 0,
      },
    },
    fullParse: {
      title: full?.title || "",
      price: full?.price ?? null,
      shippingFee: full?.shippingFee ?? null,
      debugPrice: full?.__debug?.price || null,
      detailSource: full?.__debug?.detailSource || "",
    },
    recommendationShippingRule: {
      shippingPolicy: "actual",
      meaning: {
        "0": "free_shipping",
        "-1": "paid_but_unknown_amount",
        "positive_number": "paid_shipping_amount",
        "null": "unknown -> fallback(unknownAmount)",
      },
    },
    openApiRaw: openApi,
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(String(e?.stack || e?.message || e));
  process.exit(1);
});
