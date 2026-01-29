import { coupangRequest } from "../client.js";
import { ENDPOINTS } from "../endpoints.js";

export async function createSellerProduct({ vendorId, body, accessKey, secretKey }) {
  return coupangRequest({
    method: "POST",
    path: ENDPOINTS.CREATE_SELLER_PRODUCT,
    query: `vendorId=${encodeURIComponent(vendorId)}`,
    body,
    accessKey,
    secretKey,
  });
}
