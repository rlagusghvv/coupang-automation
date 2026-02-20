import {
  COUPANG_VENDOR_ID,
  COUPANG_VENDOR_USER_ID,
  COUPANG_ACCESS_KEY,
  COUPANG_SECRET_KEY,
  COUPANG_DELIVERY_COMPANY_CODE,
} from "../config/env.js";
import { classifyUrl } from "../utils/urlFilter.js";
import { previewUploadFromUrl } from "./previewUploadFromUrl.js";
import { buildSellerProductBody } from "../coupang/builders/buildSellerProductBody.js";
import { createSellerProduct } from "../coupang/api/createSellerProduct.js";
import { requestProductApproval } from "../coupang/api/requestProductApproval.js";
import { getSellerProduct } from "../coupang/api/getSellerProduct.js";
import { getSellerProductHistories } from "../coupang/api/getSellerProductHistories.js";
import { getCategoryMetas } from "../coupang/api/getCategoryMetas.js";
import { checkAutoCategoryAgreed } from "../coupang/api/checkAutoCategoryAgreed.js";
import { recommendCategory } from "../coupang/api/recommendCategory.js";
import { suggestTitlesHybrid, cleanTitle } from "../utils/titleSuggest.js";
import { buildSingleItem } from "../coupang/builders/buildSingleItem.js";
import fs from "node:fs";
import path from "node:path";
import { extractImageUrls, buildImageOnlyHtmlFromUrls } from "../utils/contentImages.js";
import { resolveDisplayCategoryCode } from "../utils/categoryMap.js";
import { computePrice } from "../utils/price.js";
import { resolveLocalImageBase, buildLocalImageUrl } from "../utils/localImageHost.js";
import { downloadImagesWithPlaywright } from "../utils/playwrightImageDownload.js";
import { normalizeImageForCoupang } from "../utils/imageNormalize.js";
import { deployPagesAssets } from "../utils/pagesDeploy.js";
import { downloadImageBufferWithPlaywright } from "../utils/downloadImage.js";
import { uploadMarketplaceImage } from "../coupang/api/uploadMarketplaceImage.js";
import { uploadWingImage } from "../coupang/api/uploadWingImage.js";
import { getLastWingUploadedImage, getWingUploadedImages } from "../utils/wingCapture.js";

const OUTBOUND_SHIPPING_PLACE_CODE = "24093380";
const DISPLAY_CATEGORY_CODE = 77723;
const IP_CHECK_URLS = ["https://ifconfig.me/ip", "https://api.ipify.org"];
const IMAGE_CHECK_TIMEOUT_MS = 8000;

function limitLen(s, max = 30) {
  const str = String(s || "").replace(/\s+/g, " ").trim();
  if (!str) return "";
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function makeUniqueOptions(list) {
  const seen = new Map();
  const out = [];
  let idx = 0;
  for (const raw of list) {
    const rawName = typeof raw === "object" && raw ? raw.name : raw;
    const priceDelta =
      typeof raw === "object" && raw && Number.isFinite(Number(raw.priceDelta))
        ? Number(raw.priceDelta)
        : 0;
    const stock =
      typeof raw === "object" && raw && Number.isFinite(Number(raw.stock))
        ? Number(raw.stock)
        : null;
    const values =
      typeof raw === "object" && raw && Array.isArray(raw.values) ? raw.values : [];

    const base = String(rawName || "").replace(/\s+/g, " ").trim();
    if (!base) continue;
    const valueKey = values
      .map((v) => `${String(v.optionName || "").trim()}:${String(v.optionValue || "").trim()}`)
      .join("|");
    const key = `${base.toLowerCase()}::${priceDelta}::${valueKey}`;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    const uniqNameRaw = count === 1 ? base : `${base} (${count})`;
    const uniqName = limitLen(uniqNameRaw, 30);
    const hasValues = Array.isArray(values) && values.length > 0;
    idx += 1;
    out.push({
      label: hasValues ? `${uniqName}` : limitLen(`${idx}. ${uniqName}`, 30),
      priceDelta,
      stock,
      values,
    });
  }
  return out;
}

function buildItemAttributesFromOptionValues(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const attrs = values
    .map((v) => {
      const rawName = String(v?.optionName || "").trim();
      const attributeTypeName = limitLen(
        rawName
          .replace(/색깔/g, "색상")
          .replace(/크기|사이즈/g, "사이즈"),
        30,
      );
      const attributeValueName = limitLen(String(v?.optionValue || "").trim(), 30);
      if (!attributeTypeName || !attributeValueName) return null;
      return { attributeTypeName, attributeValueName };
    })
    .filter(Boolean);
  return attrs.length > 0 ? attrs : null;
}

export async function runUploadFromUrl(inputUrl, settings = {}) {
  const c = classifyUrl(inputUrl);
  if (!c.ok) {
    return { ok: false, skipped: true, reason: c.reason, url: c.url };
  }

  const payloadOnly = String(settings.payloadOnly || "").trim() === "1";
  const allowedIpsRaw =
    String(settings.allowedIps || process.env.COUPANG_ALLOWED_IPS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (!payloadOnly && allowedIpsRaw.length > 0) {
    const currentIp = await getPublicIp().catch(() => "");
    if (!currentIp || !allowedIpsRaw.includes(currentIp)) {
      return {
        ok: false,
        skipped: true,
        reason: "ip_not_allowed",
        ip: currentIp || "",
        allowedIps: allowedIpsRaw,
      };
    }
  }

  // 사용자별 설정 우선
  const accessKey = String(settings.coupangAccessKey || COUPANG_ACCESS_KEY || "").trim();
  const secretKey = String(settings.coupangSecretKey || COUPANG_SECRET_KEY || "").trim();
  let vendorId = String(settings.coupangVendorId || COUPANG_VENDOR_ID || "").trim();
  let vendorUserId = String(
    settings.coupangVendorUserId || COUPANG_VENDOR_USER_ID || "",
  ).trim();
  let deliveryCompanyCode = String(
    settings.coupangDeliveryCompanyCode || COUPANG_DELIVERY_COMPANY_CODE || "",
  ).trim();

  // 서버는 키 없이도 뜰 수 있어야 하므로, 여기서만 검증한다.
  if (!payloadOnly) {
    const missing = [];
    if (!accessKey) missing.push("COUPANG_ACCESS_KEY");
    if (!secretKey) missing.push("COUPANG_SECRET_KEY");
    if (!vendorId) missing.push("COUPANG_VENDOR_ID");
    if (!vendorUserId) missing.push("COUPANG_VENDOR_USER_ID");
    if (!deliveryCompanyCode) missing.push("COUPANG_DELIVERY_COMPANY_CODE");
    if (missing.length > 0) {
      return { ok: false, skipped: true, reason: "missing_coupang_env", missing };
    }
  } else {
    // payloadOnly(dry-run) should work without real credentials.
    // Provide safe placeholders so body builders don't throw.
    if (!vendorId) {
      vendorId = "DUMMY";
      settings.coupangVendorId = settings.coupangVendorId || vendorId;
    }
    if (!vendorUserId) {
      vendorUserId = "DUMMY";
      settings.coupangVendorUserId = settings.coupangVendorUserId || vendorUserId;
    }
    if (!deliveryCompanyCode) {
      deliveryCompanyCode = "DUMMY";
      settings.coupangDeliveryCompanyCode = settings.coupangDeliveryCompanyCode || deliveryCompanyCode;
    }
  }

  // IMPORTANT: Use the same preview pipeline for upload.
  // This ensures Domeggook OpenAPI detail images & referer/probe logic are applied.
  const prev = await previewUploadFromUrl(c.url, settings);
  const draft = prev?.draft;
  const computed = prev?.computed || {};

  const rawMax = Number(settings.maxContentImages);
  const maxContentImages = Number.isFinite(rawMax) ? rawMax : 20;

  const imagesOverride = Array.isArray(settings.imagesOverride)
    ? settings.imagesOverride.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  // preview.computed.images contains [main, ...detail]
  const computedImages = Array.isArray(computed.images) ? computed.images : [];
  const detailFromPreview = computedImages.slice(1);

  let contentImages = (imagesOverride.length > 0 ? imagesOverride : detailFromPreview)
    .slice(0, Math.max(0, maxContentImages))
    .filter(Boolean);

  // For approvals, external detail image URLs are the #1 rejection source.
  // Default: build detail images from Wing uploader captures (vendor_inventory paths).
  // Default: keep detail images off in execute (stability-first). Can be enabled per-run.
  const includeDetailImages = String(settings.includeDetailImages ?? '0').trim() === '1';
  const useWingCaptureDetailImages = String(settings.useWingCaptureDetailImages ?? '0').trim() !== '0';
  if (includeDetailImages && useWingCaptureDetailImages) {
    const wingDetails = getWingUploadedImages({ imageType: 'DETAIL' })
      .map((x) => x.vendorPath)
      .filter(Boolean);
    if (wingDetails.length > 0) {
      contentImages = wingDetails;
    }
  }

  // If still not set, skip detail images by default.
  if (!includeDetailImages) {
    contentImages = [];
  }

  function stripImgTags(html) {
    return String(html || "").replace(/<img\b[^>]*>/gi, "");
  }

  // Default outputs
  let imageUrl = draft.imageUrl;
  // Never fall back to raw page text; keep details image-only.
  let contentHtml = "";

  // ✅ Best-effort: Upload images to Coupang/Wing first (prevents image_host_unreachable)
  // If disabled, falls back to the previous "public hosting" approach.
  // Default: no-login mode (external public image URLs).
  const useCoupangImageUpload = String(settings.useCoupangImageUpload ?? "0").trim() !== "0";

  // Try image upload first; if it fails, fall back to public hosting instead of hard-failing.
  // NOTE: Wing internal uploader cannot be used headless reliably (Akamai). We can reuse
  // a recently uploaded Wing image from capture log as a temporary, stable representation.
  // Default: off (no-login mode). Only enable when explicitly doing Wing-based uploads.
  const useWingCaptureUploadedRep = String(settings.useWingCaptureUploadedRep ?? '0').trim() !== '0';

  if (!payloadOnly && useCoupangImageUpload) {
    try {
      // 1) Main image
      // Prefer reusing the last Wing UI upload (most reliable) to avoid CDN/hotlink issues.
      // If available, FORCE it (override any other upload attempts) to prevent external URL rejections.
      let mainEndpoint = null;
      if (useWingCaptureUploadedRep) {
        const last = getLastWingUploadedImage({ imageType: 'REPRESENTATION' });
        if (last?.vendorPath) {
          imageUrl = last.vendorPath;
          mainEndpoint = 'wing-capture';
        }
      }

      // If we still don't have a Wing vendorPath, download and try upload APIs.
      const needMainUpload = imageUrl === draft.imageUrl;

      // Try official API first
      let mainUp = { ok: false };
      let mainDl = null;
      if (needMainUpload) {
        mainDl = await downloadImageBufferWithPlaywright({
          pageUrl: draft.sourceUrl,
          imageUrl: draft.imageUrl,
        });
        if (!mainDl?.ok) throw new Error("main_image_download_failed");

        mainUp = await uploadMarketplaceImage({
          vendorId,
          buffer: mainDl.buffer,
          fileName: `main${mainDl.ext || ".jpg"}`,
          mimeType: mainDl.mimeType || "image/jpeg",
          accessKey,
          secretKey,
        });
      }

      // If we already have a Wing vendorPath, skip upload.
      if (imageUrl === draft.imageUrl) {
        // Fallback: Wing internal uploader (more reliable for approvals)
        if (!mainUp.ok || !(mainUp.vendorPath || mainUp.cdnPath)) {
        // 1) If user just uploaded an image in Wing UI, reuse that vendorPath from capture log.
        if (useWingCaptureUploadedRep) {
          const last = getLastWingUploadedImage({ imageType: 'REPRESENTATION' });
          if (last?.vendorPath) {
            mainUp = { ok: true, vendorPath: last.vendorPath, cdnPath: null, endpoint: 'wing-capture' };
          }
        }

        // 2) Try programmatic Wing upload (may fail due to Akamai/headless constraints)
        if (!mainUp.ok || !(mainUp.vendorPath || mainUp.cdnPath)) {
          // write temp file
          const tmpMainPath = path.join(process.cwd(), "out", `wing_main_${Date.now()}.jpg`);
          try { fs.writeFileSync(tmpMainPath, Buffer.from(mainDl.buffer)); } catch {}
          const wingUp = await uploadWingImage({ filePath: tmpMainPath, imageType: "REPRESENTATION" });
          if (!wingUp.ok || !wingUp.vendorPath) throw new Error("wing_image_upload_failed");
          mainUp = { ok: true, vendorPath: wingUp.vendorPath, cdnPath: null, endpoint: "wing" };
        }
        }

        imageUrl = mainUp.vendorPath || mainUp.cdnPath;
      }

      // 2) Content images (optional)
      // NOTE: Until we can upload detail images through Wing programmatically,
      // keep contentHtml empty when we used Wing-captured rep image (prevents approval rejects
      // due to unreachable external detail images).
      const uploadedContentUrls = [];
      const allowContentUpload = !(mainEndpoint === 'wing-capture') && !(mainUp?.endpoint === 'wing-capture');
      if (allowContentUpload) for (const u of contentImages) {
        try {
          const dl = await downloadImageBufferWithPlaywright({
            pageUrl: draft.sourceUrl,
            imageUrl: u,
          });
          if (!dl?.ok) continue;

          // 1) official api
          let up = await uploadMarketplaceImage({
            vendorId,
            buffer: dl.buffer,
            fileName: `content${dl.ext || ".jpg"}`,
            mimeType: dl.mimeType || "image/jpeg",
            accessKey,
            secretKey,
          });

          // 2) wing uploader fallback
          if (!up.ok || !(up.vendorPath || up.cdnPath)) {
            const tmpPath = path.join(process.cwd(), "out", `wing_content_${Date.now()}_${Math.random().toString(16).slice(2)}.jpg`);
            try { fs.writeFileSync(tmpPath, Buffer.from(dl.buffer)); } catch {}
            let wingUp = await uploadWingImage({ filePath: tmpPath, imageType: "DETAIL" });
            if (!wingUp.ok) {
              wingUp = await uploadWingImage({ filePath: tmpPath, imageType: "REPRESENTATION" });
            }
            if (wingUp.ok && wingUp.vendorPath) {
              up = { ok: true, vendorPath: wingUp.vendorPath, cdnPath: null, endpoint: "wing" };
            }
          }

          const src = up?.cdnPath || up?.vendorPath;
          if (src) uploadedContentUrls.push(src);
        } catch {
          // ignore single image failure
        }
      }

      // Build clean HTML with only Coupang-hosted images
      if (uploadedContentUrls.length > 0) {
        contentHtml = buildImageOnlyHtmlFromUrls(uploadedContentUrls);
      } else if (mainUp?.endpoint === 'wing-capture') {
        contentHtml = '';
      }
    } catch {
      // Fall back to public hosting approach below
    }
  }

  const needFallbackHosting =
    (
      !useCoupangImageUpload ||
      imageUrl === draft.imageUrl ||
      (contentImages.length > 0 && !contentHtml)
    );

  if (needFallbackHosting) {
    // Fallback: download images and expose via local/public base URL
    const localImageBase = resolveLocalImageBase(settings);
    const outDir = path.join(process.cwd(), "out");

    // If main image is already uploaded to Coupang, we only need content images.
    const downloadList = Array.from(
      new Set(
        imageUrl === draft.imageUrl
          ? [draft.imageUrl, ...contentImages]
          : [...contentImages],
      ),
    ).filter(Boolean);

    const { DOMEGGOOK_STORAGE_STATE_PATH } = await import("../config/paths.js");
    const storageStatePath = DOMEGGOOK_STORAGE_STATE_PATH;
    const downloaded = await downloadImagesWithPlaywright({
      pageUrl: draft.sourceUrl,
      imageUrls: downloadList,
      outDir,
      baseUrl: localImageBase,
      storageStatePath,
    });

    // Safety: normalize downloaded files in-place to satisfy Coupang image constraints.
    // Some sources provide tiny thumbnails (e.g. 330x330) which get approval-rejected.
    for (const f of downloaded.files || []) {
      try {
        if (!f?.filePath) continue;
        const tmp = `${f.filePath}.norm_${Date.now()}.jpg`;
        await normalizeImageForCoupang({ inputPath: f.filePath, outputPath: tmp });
        try { fs.renameSync(tmp, f.filePath); } catch { try { fs.copyFileSync(tmp, f.filePath); } catch {} try { fs.unlinkSync(tmp); } catch {} }
      } catch {}
    }

    if (String(settings.pagesAutoDeploy || "").trim() === "1") {
      const deployRes = await deployPagesAssets({
        directory: outDir,
        subDirName: "couplus-out",
        projectName: String(settings.pagesProjectName || "").trim(),
        apiToken: String(settings.pagesApiToken || "").trim(),
        accountId: String(settings.pagesAccountId || "").trim(),
      });
      if (!deployRes.ok) {
        return {
          ok: false,
          skipped: false,
          error: "pages_deploy_failed",
          detail: deployRes.error,
          deploy: {
            code: deployRes.code ?? null,
            stdout: deployRes.stdout || "",
            stderr: deployRes.stderr || "",
          },
        };
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Helper: ensure a local out/<file> meets Coupang image constraints.
    // We always normalize to 1200x1200 JPEG to avoid approval rejects on small thumbs (e.g. 330x330).
    async function forceNormalizeOutFile(fileName) {
      try {
        if (!fileName) return fileName;
        const baseName = String(fileName);
        const p = path.join(outDir, baseName);
        if (!fs.existsSync(p)) return fileName;

        // Write to a new stable filename to avoid any race/overwrite issues.
        const ext = path.extname(baseName) || '.jpg';
        const stem = ext ? baseName.slice(0, -ext.length) : baseName;
        const normalizedName = `${stem}.cp_norm.jpg`;
        const outPath = path.join(outDir, normalizedName);

        await normalizeImageForCoupang({ inputPath: p, outputPath: outPath });
        return normalizedName;
      } catch {
        return fileName;
      }
    }

    // Helper: for a downloaded file, generate a public URL and verify it's reachable.
    async function pickReachablePublicUrl(fileName, { attempts = 8, timeoutMs = IMAGE_CHECK_TIMEOUT_MS } = {}) {
      if (!fileName) return "";
      // Normalize first to ensure >=500x500
      const normalizedName = await forceNormalizeOutFile(fileName);
      for (let i = 0; i < attempts; i += 1) {
        const u = buildLocalImageUrl(localImageBase, normalizedName, { cacheBust: false });
        const ok = await isUrlReachable(u, timeoutMs);
        if (ok) return u;
        // backoff
        await new Promise((r) => setTimeout(r, 700 + i * 500));
      }
      return "";
    }

    // Update main image only if we haven't already uploaded it to Coupang.
    if (imageUrl === draft.imageUrl) {
      const mainFile = (downloaded.files || []).find((f) => f.imageUrl === draft.imageUrl);
      const mainFileName = mainFile?.fileName;
      if (!mainFileName) {
        return { ok: false, skipped: false, error: "main_image_download_failed" };
      }

      const mappedMain = await pickReachablePublicUrl(mainFileName);
      if (!mappedMain) {
        return {
          ok: false,
          skipped: false,
          error: "image_host_unreachable",
          imageUrl: buildLocalImageUrl(localImageBase, mainFileName, { cacheBust: false }),
        };
      }

      imageUrl = mappedMain;
    }

    // Content images: only keep URLs that are publicly reachable.
    const contentLocalUrls = [];
    for (const src of contentImages) {
      const f = (downloaded.files || []).find((x) => x.imageUrl === src);
      if (!f?.fileName) continue;
      const pub = await pickReachablePublicUrl(f.fileName, { attempts: 4 });
      if (pub) contentLocalUrls.push(pub);
    }

    contentHtml = contentLocalUrls.length > 0 ? buildImageOnlyHtmlFromUrls(contentLocalUrls) : "";
  }

  const displayCategoryCode = resolveDisplayCategoryCode({
    title: draft.title,
    categoryText: draft.categoryText,
    fallback: DISPLAY_CATEGORY_CODE,
  });

  let finalPrice = computePrice(draft.price, {
    rate: settings.marginRate,
    add: settings.marginAdd,
    min: settings.priceMin,
    roundUnit: settings.roundUnit,
  });

  // 배송비가 유료면 "실제 배송비"만큼 판매가에 가산
  // shippingFee: 0=무료, >0=유료(금액), -1=유료(금액 표기 없음)
  const shippingFee = Number(draft.shippingFee);

  // 배송비 가격정책
  // - none: 반영 안함
  // - actual: 실제 배송비만큼 가산
  // - fixed: 유료면 고정 금액 가산
  // - error_unknown: 유료인데 금액 못 읽으면 에러
  const shippingPolicy = String(settings.shippingPolicy || "actual").trim();
  const shippingFixed = Number.isFinite(Number(settings.shippingFixedAmount))
    ? Number(settings.shippingFixedAmount)
    : 2500;

  if (shippingFee === -1 && shippingPolicy === "error_unknown") {
    return {
      ok: false,
      skipped: false,
      error: "shipping_fee_unknown",
      detail: {
        message: "배송비가 유료(착불/배송비별도)로 표시되지만 금액을 확인할 수 없어 업로드를 중단했습니다.",
        sourceUrl: draft.sourceUrl,
      },
      draft: { title: sellerProductName, price: draft.price, imageUrl: draft.imageUrl, shippingFee: draft.shippingFee },
    };
  }

  let shippingSurcharge = 0;
  if (shippingPolicy === "none") shippingSurcharge = 0;
  else if (shippingPolicy === "fixed") shippingSurcharge = shippingFee > 0 || shippingFee === -1 ? shippingFixed : 0;
  else if (shippingPolicy === "actual") shippingSurcharge = shippingFee > 0 ? shippingFee : 0;
  else if (shippingPolicy === "error_unknown") shippingSurcharge = shippingFee > 0 ? shippingFee : 0;

  const shouldAddShipping = shippingSurcharge > 0;
  if (shouldAddShipping) {
    finalPrice += shippingSurcharge;
    const roundUnit = Number.isFinite(Number(settings.roundUnit)) ? Number(settings.roundUnit) : 10;
    if (roundUnit > 1) finalPrice = Math.floor(finalPrice / roundUnit) * roundUnit;
    const min = Number.isFinite(Number(settings.priceMin)) ? Number(settings.priceMin) : 1000;
    if (Number.isFinite(min)) finalPrice = Math.max(min, finalPrice);
  }

  const useAutoCategory = String(settings.autoCategoryMatch || process.env.AUTO_CATEGORY_MATCH || "").trim() === "1";
  let allowAutoCategory = false;
  if (useAutoCategory) {
    try {
      const agreed = await checkAutoCategoryAgreed({ vendorId, accessKey, secretKey });
      allowAutoCategory = agreed.status === 200;
    } catch {
      allowAutoCategory = false;
    }
  }

  // Allow manual override
  const overrideCategoryCode = Number(
    settings.categoryOverrideCode ??
    settings.displayCategoryCode ??
    settings.categoryOverride ??
    settings.coupangDisplayCategoryCode
  );
  let finalCategoryCode = Number.isFinite(overrideCategoryCode) && overrideCategoryCode > 0
    ? overrideCategoryCode
    : displayCategoryCode;
  let notices = undefined;

  // If vendor category text is missing, try Coupang category prediction API for better accuracy.
  // This prevents bad defaults (e.g. adult-only categories).
  const canPredictCategory = accessKey && secretKey;
  const usePredict = String(settings.autoCategoryPredict ?? "1").trim() !== "0";
  if (
    canPredictCategory &&
    usePredict &&
    (!draft.categoryText || String(draft.categoryText).trim() === "") &&
    (finalCategoryCode === DISPLAY_CATEGORY_CODE)
  ) {
    try {
      const pred = await recommendCategory({
        productName: draft.title,
        productDescription: String(draft.contentText || "").replace(/<[^>]+>/g, " ").slice(0, 500),
        productImageUrl: imageUrl,
        accessKey,
        secretKey,
      });
      if (pred.status === 200) {
        const bodyObj = typeof pred.body === "string" ? JSON.parse(pred.body) : pred.body;
        const predicted = Number(bodyObj?.data?.predictedCategoryId);
        const predictedName = String(bodyObj?.data?.predictedCategoryName || "");
        const looksAdult = /성인|19\s*세|청소년\s*이용\s*불가|미성년\s*불가/i.test(predictedName);
        if (looksAdult) {
          return {
            ok: false,
            skipped: false,
            error: "adult_category_blocked",
            detail: { predictedCategoryId: predicted, predictedCategoryName: predictedName },
            draft: { title: sellerProductName, price: draft.price, imageUrl: draft.imageUrl },
          };
        }
        if (Number.isFinite(predicted) && predicted > 0) {
          // validate predicted category
          try {
            const meta = await getCategoryMetas({
              displayCategoryCode: predicted,
              accessKey,
              secretKey,
            });
            if (meta.status === 200) {
              finalCategoryCode = predicted;
            }
          } catch {}
        }
      }
    } catch {}
  }

  if (allowAutoCategory) {
    finalCategoryCode = null;
    notices = null;
  } else {
    const usePredict = String(settings.autoCategoryPredict ?? "1").trim() !== "0";
    const useRecommend =
      String(settings.autoCategoryRecommend || process.env.AUTO_CATEGORY_RECOMMEND || "").trim() === "1" ||
      usePredict;
    if (useRecommend) {
      try {
        const productName = cleanTitle(String(draft.title || "").split("|")[0]).slice(0, 80);
        const rec = await recommendCategory({
          productName,
          // Avoid noisy page text that can mislead categorization.
          productDescription: "",
          productImageUrl: imageUrl,
          accessKey,
          secretKey,
        });
        const bodyObj = typeof rec.body === "string" ? JSON.parse(rec.body) : rec.body;
        const recCode = bodyObj?.data?.predictedCategoryId;
        const recName = bodyObj?.data?.predictedCategoryName;
        if (recCode) finalCategoryCode = Number(recCode);
        // attach for result/UI (non-persistent)
        settings.__predictedCategory = { id: recCode ?? null, name: recName ?? null };
      } catch {}
    }

    try {
      const meta = await getCategoryMetas({ displayCategoryCode: finalCategoryCode, accessKey, secretKey });
      if (meta.status !== 200) {
        finalCategoryCode = DISPLAY_CATEGORY_CODE;
      }
    } catch {
      finalCategoryCode = DISPLAY_CATEGORY_CODE;
    }
  }

  // When true, Coupang will treat the product as "requested" on create (approval requested).
  // Default: ON for /api/upload/execute so users get a real upload, not a temp draft.
  const autoRequest = String(settings.autoRequest ?? settings.autoRequestApproval ?? "1").trim() === "1";

  let optionsUsed =
    Array.isArray(draft.options) && draft.options.length > 0
      ? makeUniqueOptions(draft.options)
      : [];

  // Stability-first: 옵션(구매옵션) 업로드는 쿠팡 단위수량/옵션유효성 이슈로 실패 확률이 높아서 기본 OFF.
  const disableOptions = String(settings.disableOptions ?? "1").trim() === "1";
  if (disableOptions) optionsUsed = [];

  const overrideTitle = String(settings.titleOverride || "").trim();

  // If user didn't pick a title in the UI, auto-apply the best 15-char suggestion.
  // This makes "Upload" behave like it benefited from the preview step.
  let autoSuggestedTitle = "";
  const autoTitleSuggest = String(settings.autoTitleSuggest ?? "1").trim() !== "0";
  if (!overrideTitle && autoTitleSuggest) {
    try {
      const sug = await suggestTitlesHybrid({ title: draft.title, maxLen: 15, useNaver: true });
      const first = sug?.suggestions?.[0]?.title;
      if (first) autoSuggestedTitle = String(first).trim();
    } catch {}
  }

  const sellerProductName = overrideTitle || autoSuggestedTitle || draft.title;

  function extractQtyPerUnit(title) {
    const t = String(title || "");
    const m = t.match(/(\d{1,5})\s*(매|개|개입|입|장|pcs?|p)/i);
    if (!m) return 1;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.min(99999, Math.max(1, Math.floor(n)));
  }

  function extractSize(title) {
    const t = String(title || "");
    const m = t.match(/(\d{1,4}\s*[xX×]\s*\d{1,4}(?:\s*[xX×]\s*\d{1,4})?)\s*(cm|mm|m)?/);
    if (!m) return "FREE";
    const raw = String(m[1] || "").replace(/\s*/g, "");
    const unit = String(m[2] || "cm").trim();
    return `${raw}${unit}`;
  }

  // Category 65906 (배변패드) mandatory attributes (from Wing capture): 사이즈, 개당 수량, 수량
  let itemAttributes = null;
  let itemUnit = null;
  if (Number(finalCategoryCode) === 65906) {
    const qtyPerUnit = extractQtyPerUnit(prev?.draft?.title || draft.title);
    const size = extractSize(prev?.draft?.title || draft.title);
    // For QUANTITY-related mandatory fields, Wing hint suggests including unit text.
    // (e.g. "50매", "5개입", "1개")
    itemAttributes = [
      { attributeTypeName: "사이즈", attributeValueName: String(size || 'FREE') },
      { attributeTypeName: "개당 수량", attributeValueName: `${qtyPerUnit}개입` },
      { attributeTypeName: "수량", attributeValueName: `1개` },
    ];

    // unitCount/unitType seems to be the actual "단위수량" field.
    // From Wing meta: QUANTITY baseUnit=PIECE.
    itemUnit = { unitCount: qtyPerUnit, unitType: 'PIECE' };
  }

  // Some categories/options require unitCount/unitType; when we have 구매옵션(옵션Used)이 있는 경우,
  // default a safe unit to avoid create rejection.
  if (!itemUnit) {
    // Default safe unit. Prevents occasional create rejection: "단위수량 값을 확인".
    itemUnit = { unitCount: 1, unitType: 'PIECE' };
  }

  // Final safety: force Wing-captured representation image when available (prevents external URL approval rejects).
  // Only do this in "upload-to-coupang/wing" mode. In external-URL mode (useCoupangImageUpload=0),
  // we must not override with Wing vendor_inventory paths.
  if (useCoupangImageUpload && useWingCaptureUploadedRep) {
    const last = getLastWingUploadedImage({ imageType: 'REPRESENTATION' });
    if (last?.vendorPath) {
      imageUrl = last.vendorPath;
    }
  }

  const body = buildSellerProductBody({
    vendorId,
    vendorUserId,
    outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE,
    deliveryCompanyCode: settings.coupangDeliveryCompanyCode,
    displayCategoryCode: finalCategoryCode,
    allowAutoCategory,
    sellerProductName,
    imageUrl,
    price: finalPrice,
    stock: 10,
    contentText: contentHtml,
    notices,
    requested: autoRequest,
    itemAttributes,
    itemUnit,
    items:
      optionsUsed.length > 0
        ? optionsUsed.map((opt) => {
            const rawPrice = finalPrice + (opt.priceDelta || 0);
            const minPrice = Number.isFinite(Number(settings.priceMin))
              ? Number(settings.priceMin)
              : 1000;
            const itemPrice = Math.max(minPrice, rawPrice);

            return buildSingleItem({
              itemName: opt.label,
              price: itemPrice,
              stock: Number.isFinite(opt.stock) && opt.stock > 0 ? opt.stock : 10,
              outboundShippingTimeDay: 1,
              imageUrl,
              contentText: contentHtml,
              notices,
              attributes: buildItemAttributesFromOptionValues(opt.values) || undefined,
              unitCount: itemUnit?.unitCount,
              unitType: itemUnit?.unitType,
            });
          })
        : undefined,
  });

  const payloadCheck = buildPayloadCheck({
    optionsUsed,
    finalPrice,
    priceMin: settings.priceMin,
    items: body?.items || [],
  });

  if (payloadOnly) {
    return {
      ok: true,
      payloadOnly: true,
      payload: body,
      payloadCheck,
      draft: { title: sellerProductName, price: draft.price, imageUrl: draft.imageUrl },
      finalPrice,
      category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory, predicted: settings.__predictedCategory || null },
      optionsUsed: optionsUsed.map((opt) => opt.label),
    };
  }

  const res = await createSellerProduct({
    vendorId,
    body,
    accessKey,
    secretKey,
  });

  let createdId = null;
  let createBody = res.body;
  let createBodyObj = null;
  try {
    createBodyObj = typeof res.body === "string" ? JSON.parse(res.body) : res.body;

    const code = String(createBodyObj?.code || "").toUpperCase();
    if (code && code !== "SUCCESS") {
      return {
        ok: false,
        error: "coupang_create_failed",
        detail: createBodyObj,
        draft: { title: sellerProductName, price: draft.price, imageUrl: draft.imageUrl },
        finalPrice,
        category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory, predicted: settings.__predictedCategory || null },
        optionsUsed: optionsUsed.map((opt) => opt.label),
        payloadCheck,
        payloadSummary: {
          displayCategoryCode: finalCategoryCode,
          itemCount: Array.isArray(body?.items) ? body.items.length : 0,
          firstItem: (() => {
            const it = Array.isArray(body?.items) ? body.items[0] : null;
            if (!it) return null;
            return {
              itemName: it.itemName,
              unitCount: it.unitCount,
              unitType: it.unitType,
              attributes: it.attributes,
            };
          })(),
        },
        create: { status: res.status, body: createBody, sellerProductId: null },
      };
    }

    // Even with code=SUCCESS, Coupang may return errorItems for required attributes.
    const errorItems = Array.isArray(createBodyObj?.errorItems) ? createBodyObj.errorItems : [];
    if (errorItems.length > 0) {
      createdId = createBodyObj?.data ?? null;
      return {
        ok: false,
        error: "coupang_required_attributes_missing",
        detail: createBodyObj,
        draft: { title: sellerProductName, price: draft.price, imageUrl: draft.imageUrl },
        finalPrice,
        category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory, predicted: settings.__predictedCategory || null },
        optionsUsed: optionsUsed.map((opt) => opt.label),
        payloadCheck,
        create: { status: res.status, body: createBody, sellerProductId: createdId },
        followUp: createdId ? await pollApprovalStatus({ sellerProductId: createdId, accessKey, secretKey, attempts: 1, delayMs: 500 }) : null,
      };
    }

    createdId = createBodyObj?.data ?? null;
  } catch {}

  let approval = null;
  if (createdId && !autoRequest) {
    const ar = await requestProductApproval({ sellerProductId: createdId, accessKey, secretKey });
    approval = { status: ar.status, body: ar.body };
  }

  let followUp = null;
  if (createdId) {
    followUp = await pollApprovalStatus({
      sellerProductId: createdId,
      accessKey,
      secretKey,
      attempts: 3,
      delayMs: 3000,
    });
  }

  return {
    ok: true,
    draft: { title: draft.title, price: draft.price, imageUrl: draft.imageUrl },
    finalPrice,
    category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory, predicted: settings.__predictedCategory || null },
    optionsUsed: optionsUsed.map((opt) => opt.label),
    payloadCheck,
    debug: {
      usedMainImageVendorPath: imageUrl,
      usedContentHtmlLen: String(contentHtml || '').length,
      useWingCaptureUploadedRep,
    },
    create: { status: res.status, body: createBody, sellerProductId: createdId },
    approval,
    followUp,
  };
}

async function getPublicIp() {
  for (const url of IP_CHECK_URLS) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (text && text.length < 80) return text;
    } catch {}
  }
  return "";
}

async function isUrlReachable(url, timeoutMs = 8000) {
  if (!url) return false;

  // DNS on some hosts may lag behind for newly created hostnames (e.g. app2.* right after record creation).
  // If a direct fetch fails due to DNS, try resolving via the public IPs that Cloudflare already returns
  // for app2.splui.com (bypass local resolver).
  const host = (() => {
    try { return new URL(url).hostname; } catch { return ""; }
  })();

  const shouldRetry = url.includes(".pages.dev") || url.includes("/couplus-out/");
  const maxAttempts = shouldRetry ? 3 : 1;

  async function tryFetch(u) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const head = await fetch(u, { method: "HEAD", redirect: "follow", signal: controller.signal });
      if (head.ok) return true;
    } catch {}
    try {
      const get = await fetch(u, { method: "GET", redirect: "follow", signal: controller.signal });
      if (get.ok) return true;
    } catch {}
    clearTimeout(timer);
    return false;
  }

  // Normal path
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const ok = await tryFetch(url);
    if (ok) return true;

    // DNS bypass for app2
    if (host === "app2.splui.com") {
      const fallbackIps = ["104.21.89.114", "172.67.141.123"];
      for (const ip of fallbackIps) {
        try {
          const u = new URL(url);
          u.hostname = ip;
          const ok2 = await tryFetch(u.toString());
          if (ok2) return true;
        } catch {}
      }
    }

    if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, 2000));
  }

  return false;
}

async function pollApprovalStatus({
  sellerProductId,
  accessKey,
  secretKey,
  attempts = 3,
  delayMs = 3000,
}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await getSellerProduct({ sellerProductId, accessKey, secretKey });
      const bodyObj = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
      const data = bodyObj?.data || {};
      const statusName = data?.statusName || data?.status?.statusName || data?.status || "";
      const productId = data?.productId || data?.displayProductId || null;
      const vendorItemId = data?.vendorItemId || null;
      const approved =
        String(statusName).includes("승인완료") || String(statusName).toUpperCase() === "APPROVED";
      last = {
        status: res.status,
        statusName,
        approved,
        productId,
        vendorItemId,
      };
      if (approved) break;

      try {
        const hist = await getSellerProductHistories({ sellerProductId, accessKey, secretKey });
        const histBody = typeof hist.body === "string" ? JSON.parse(hist.body) : hist.body;
        const items = histBody?.data || [];
        if (Array.isArray(items) && items.length > 0) {
          last.lastHistory = items[0];
        }
      } catch {}
    } catch {}

    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }

  if (last?.productId) {
    last.productUrl = `https://www.coupang.com/vp/products/${last.productId}`;
  }
  return last;
}

function buildPayloadCheck({ optionsUsed = [], finalPrice, priceMin, items = [] } = {}) {
  const minPrice = Number.isFinite(Number(priceMin)) ? Number(priceMin) : 1000;
  const itemList = Array.isArray(items) ? items : [];
  const itemMap = new Map(itemList.map((item) => [item?.itemName, item]));

  if (!Array.isArray(optionsUsed) || optionsUsed.length === 0) {
    const single = itemList[0] || {};
    const expectedPrice = Number(finalPrice);
    const expectedStock = 10;
    const actualPrice = Number(single?.salePrice ?? single?.originalPrice ?? single?.price);
    const actualStock = Number(single?.maximumBuyCount ?? single?.stock);
    const priceOk = Number.isFinite(actualPrice) && actualPrice === expectedPrice;
    const stockOk = Number.isFinite(actualStock) && actualStock === expectedStock;
    const check = {
      label: single?.itemName || "단품",
      expectedPrice,
      actualPrice: Number.isFinite(actualPrice) ? actualPrice : null,
      expectedStock,
      actualStock: Number.isFinite(actualStock) ? actualStock : null,
      usedMinPrice: false,
      priceOk,
      stockOk,
    };
    const summary = {
      total: 1,
      missingItem: priceOk || stockOk ? 0 : 1,
      priceMismatch: priceOk ? 0 : 1,
      stockMismatch: stockOk ? 0 : 1,
    };
    return { ok: priceOk && stockOk, summary, checks: [check] };
  }

  const checks = optionsUsed.map((opt) => {
    const item = itemMap.get(opt.label);
    const rawExpected = Number(finalPrice) + Number(opt.priceDelta || 0);
    const expectedPrice = Math.max(minPrice, rawExpected);
    const expectedStock =
      Number.isFinite(opt.stock) && Number(opt.stock) > 0 ? Number(opt.stock) : 10;
    const actualPrice = Number(item?.salePrice ?? item?.originalPrice ?? item?.price);
    const actualStock = Number(item?.maximumBuyCount ?? item?.stock);
    const priceOk = Number.isFinite(actualPrice) && actualPrice === expectedPrice;
    const stockOk = Number.isFinite(actualStock) && actualStock === expectedStock;
    return {
      label: opt.label,
      priceDelta: Number(opt.priceDelta || 0),
      expectedPrice,
      actualPrice: Number.isFinite(actualPrice) ? actualPrice : null,
      expectedStock,
      actualStock: Number.isFinite(actualStock) ? actualStock : null,
      usedMinPrice: rawExpected < minPrice,
      priceOk,
      stockOk,
    };
  });

  const summary = {
    total: checks.length,
    missingItem: checks.filter((c) => c.actualPrice == null && c.actualStock == null).length,
    priceMismatch: checks.filter((c) => !c.priceOk).length,
    stockMismatch: checks.filter((c) => !c.stockOk).length,
  };
  const ok = summary.priceMismatch === 0 && summary.stockMismatch === 0;
  return { ok, summary, checks };
}
