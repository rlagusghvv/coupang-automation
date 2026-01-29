import { coupangRequest } from "../../coupang/client.js";
import { COUPANG_VENDOR_ID } from "../../config/env.js";

(async () => {
  const sellerProductId = process.argv[2];
  if (!sellerProductId) {
    console.log('Usage: node src/pipeline/steps/step22_get_product_by_id.js "SELLER_PRODUCT_ID"');
    process.exit(1);
  }

  const res = await coupangRequest({
    method: "GET",
    path: `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`,
    query: `vendorId=${encodeURIComponent(COUPANG_VENDOR_ID)}`,
  });

  console.log("STATUS:", res.status);
  console.log("BODY:", res.body);
})();
