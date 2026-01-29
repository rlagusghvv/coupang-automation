import { buildAttributes } from "./buildAttributes.js";
import { buildItemImages } from "./buildItemImages.js";
import { buildNoticesEtcGoods } from "./buildNoticesEtcGoods.js";
import { buildContentsText } from "./buildContentsText.js";

export function buildSingleItem({
  itemName = "단품",
  price = 9900,
  stock = 10,
  outboundShippingTimeDay = 1,
  imageUrl,
  contentText = "테스트 상품입니다.",
  notices,
} = {}) {
  if (!imageUrl) throw new Error("imageUrl required (item)");

  const item = {
    itemName,
    originalPrice: price,
    salePrice: price,

    maximumBuyCount: stock,
    maximumBuyForPerson: 0,
    maximumBuyForPersonPeriod: 1,

    outboundShippingTimeDay,

    taxType: "TAX",
    adultOnly: "EVERYONE",
    parallelImported: "NOT_PARALLEL_IMPORTED",
    overseasPurchased: "NOT_OVERSEAS_PURCHASED",
    overseasPurchase: "NOT_OVERSEAS_PURCHASED",

    unitCount: 1,

    attributes: buildAttributes(),
    images: [
      {
        imageOrder: 0,
        imageType: "REPRESENTATION",
        vendorPath: imageUrl,
      },
    ],
    notices: notices ?? buildNoticesEtcGoods(),
    contents: buildContentsText({ text: contentText }),
  };

  if (notices === null) delete item.notices;

  return item;
}
