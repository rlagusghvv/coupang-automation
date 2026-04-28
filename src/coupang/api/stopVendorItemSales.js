import { coupangRequest } from "../client.js";

export async function stopVendorItemSales({ vendorItemId, accessKey, secretKey }) {
  const id = String(vendorItemId || "").trim();
  if (!id) throw new Error("vendorItemId required");
  return coupangRequest({
    method: "PUT",
    path: `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${encodeURIComponent(id)}/sales/stop`,
    accessKey,
    secretKey,
  });
}
