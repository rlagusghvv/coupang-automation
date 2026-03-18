const LARGE_INTEGER_FIELDS = [
  "shipmentBoxId",
  "shipmentBoxNo",
  "orderId",
  "deliveryId",
  "vendorItemId",
  "sellerProductId",
  "sellerProductItemId",
  "productId",
  "vendorItemPackageId",
  "orderItemId",
  "orderItemNo",
  "responseKey",
];

const LARGE_INTEGER_PATTERN = new RegExp(
  `"(${LARGE_INTEGER_FIELDS.join("|")})"\\s*:\\s*(-?\\d{15,})`,
  "g",
);

export function parseCoupangJson(raw) {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw;
  const normalized = raw.replace(LARGE_INTEGER_PATTERN, (_, key, value) => `"${key}":"${value}"`);
  return JSON.parse(normalized);
}
