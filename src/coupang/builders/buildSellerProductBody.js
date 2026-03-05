import { deliveryFree } from "../policies/deliveryFree.js";
import { returnNoCenter } from "../policies/returnNoCenter.js";
import { buildTopImages } from "./buildTopImages.js";
import { buildSingleItem } from "./buildSingleItem.js";

function normalizeSearchTags(searchTags = []) {
  const src = Array.isArray(searchTags)
    ? searchTags
    : String(searchTags || "")
        .split(/\n|,/)
        .map((x) => String(x || "").trim())
        .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const raw of src) {
    const cleaned = String(raw || "")
      .replace(/[^0-9A-Za-z가-힣\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) continue;
    if (cleaned.length < 2) continue;
    const one = cleaned.length > 20 ? cleaned.slice(0, 20).trim() : cleaned;
    if (!one) continue;
    const key = one.replace(/\s+/g, "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(one);
    if (out.length >= 10) break;
  }
  return out;
}

export function buildSellerProductBody({
  vendorId,
  vendorUserId,
  outboundShippingPlaceCode,
  displayCategoryCode,
  sellerProductName,
  brand = "기타",
  manufacturer = "기타",
  imageUrl,
  price = 9900,
  stock = 10,
  contentText = "", // ✅ 추가
  notices,
  allowAutoCategory = false,
  requested = false,
  searchTags = [],
  items,
  itemAttributes,
  itemUnit,
  deliveryCompanyCode,
} = {}) {  
  if (!vendorId) throw new Error("vendorId required");
  if (!vendorUserId) throw new Error("vendorUserId required");
  if (!outboundShippingPlaceCode) throw new Error("outboundShippingPlaceCode required");
  if (displayCategoryCode == null && !allowAutoCategory) {
    throw new Error("displayCategoryCode required");
  }
  if (!sellerProductName) throw new Error("sellerProductName required");
  if (!imageUrl) throw new Error("imageUrl required (top)");

  const normalizedSearchTags = normalizeSearchTags(searchTags);

  const body = {
    vendorId,
    vendorUserId,
    requested: Boolean(requested),

    ...(displayCategoryCode != null ? { displayCategoryCode } : {}),
    sellerProductName,
    brand,
    manufacturer,

    saleStartedAt: "2020-01-01T00:00:00",
    saleEndedAt: "2099-12-31T23:59:59",

    outboundShippingPlaceCode: Number(outboundShippingPlaceCode),
    ...(normalizedSearchTags.length > 0 ? { searchTags: normalizedSearchTags } : {}),

    ...deliveryFree({ deliveryCompanyCode }),
    ...returnNoCenter(),

    images: buildTopImages({ url: imageUrl }),
    items: Array.isArray(items) && items.length > 0
      ? items
      : [
          buildSingleItem({
            itemName: "단품",
            price,
            stock,
            outboundShippingTimeDay: 1,
            imageUrl,
            contentText, // ✅ draft에서 내려온 상세 주입
            notices,
            attributes: itemAttributes,
            unitCount: itemUnit?.unitCount,
            unitType: itemUnit?.unitType,
          }),
        ],
  };

  return body;
}
