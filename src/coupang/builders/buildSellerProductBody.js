import { deliveryFree } from "../policies/deliveryFree.js";
import { returnNoCenter } from "../policies/returnNoCenter.js";
import { buildTopImages } from "./buildTopImages.js";
import { buildSingleItem } from "./buildSingleItem.js";

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
  items,
} = {}) {
  if (!vendorId) throw new Error("vendorId required");
  if (!vendorUserId) throw new Error("vendorUserId required");
  if (!outboundShippingPlaceCode) throw new Error("outboundShippingPlaceCode required");
  if (displayCategoryCode == null && !allowAutoCategory) {
    throw new Error("displayCategoryCode required");
  }
  if (!sellerProductName) throw new Error("sellerProductName required");
  if (!imageUrl) throw new Error("imageUrl required (top)");

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

    ...deliveryFree(),
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
          }),
        ],
  };

  return body;
}
