import { coupangRequest } from "../client.js";

export async function checkAutoCategoryAgreed({ vendorId, accessKey, secretKey }) {
  if (!vendorId) throw new Error("vendorId required");
  return coupangRequest({
    method: "GET",
    path: `/v2/providers/seller_api/apis/api/v1/marketplace/vendors/${vendorId}/check-auto-category-agreed`,
    accessKey,
    secretKey,
  });
}
