import { coupangRequest } from "../client.js";
import { ENDPOINTS } from "../endpoints.js";

export async function getSellerProduct({ sellerProductId, accessKey, secretKey }) {
  const path = ENDPOINTS.GET_SELLER_PRODUCT.replace(
    "{sellerProductId}",
    encodeURIComponent(String(sellerProductId || "")),
  );
  return coupangRequest({
    method: "GET",
    path,
    accessKey,
    secretKey,
  });
}
