import { classifyUrl } from "../utils/urlFilter.js";
import { parseProductFromDomaeqq } from "../sources/domaeqq/parseProductFromDomaeqq.js";
import { extractImageUrls } from "../utils/contentImages.js";
import { computePrice } from "../utils/price.js";

function uniq(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(Boolean)));
}

export async function previewUploadFromUrl(inputUrl, settings = {}) {
  const c = classifyUrl(inputUrl);
  if (!c.ok) {
    return { ok: false, reason: c.reason, url: c.url };
  }

  const draft = await parseProductFromDomaeqq(c.url);

  const rawMax = Number(settings.maxContentImages);
  const maxContentImages = Number.isFinite(rawMax) ? rawMax : 30;
  const contentImages = extractImageUrls(draft.contentText)
    .slice(0, Math.max(0, maxContentImages))
    .filter(Boolean);

  const finalPrice = computePrice(draft.price, {
    rate: settings.marginRate,
    add: settings.marginAdd,
    min: settings.priceMin,
    roundUnit: settings.roundUnit,
  });

  const mainImageUrl = draft.imageUrl || "";
  const images = uniq([mainImageUrl, ...contentImages]);
  const options = Array.isArray(draft.options) ? draft.options : [];

  return {
    ok: true,
    url: c.url,
    draft: {
      title: draft.title || "",
      categoryText: draft.categoryText || "",
      price: draft.price ?? null,
      imageUrl: mainImageUrl,
      sourceUrl: draft.sourceUrl || c.url,
    },
    computed: {
      finalPrice,
      images,
      contentImageCount: contentImages.length,
      optionsCount: options.length,
    },
    options,
  };
}
