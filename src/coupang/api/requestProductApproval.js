import { coupangRequest } from "../client.js";

export async function requestProductApproval({ sellerProductId }) {
  if (!sellerProductId) throw new Error("sellerProductId required");
  return coupangRequest({
    method: "PUT",
    path: `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}/approvals`,
  });
}
