import { coupangRequest } from "../client.js";
import { ENDPOINTS } from "../endpoints.js";

export async function deleteSellerProduct({ sellerProductId, accessKey, secretKey }) {
  const path = ENDPOINTS.GET_SELLER_PRODUCT.replace(
    "{sellerProductId}",
    encodeURIComponent(String(sellerProductId || "")),
  );
  return coupangRequest({
    method: 'DELETE',
    path,
    accessKey,
    secretKey,
  });
}
