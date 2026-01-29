import { COUPANG_VENDOR_ID, COUPANG_VENDOR_USER_ID } from "../../config/env.js";
import { buildSellerProductBody } from "../../coupang/builders/buildSellerProductBody.js";
import { createSellerProduct } from "../../coupang/api/createSellerProduct.js";

const OUTBOUND_SHIPPING_PLACE_CODE = "24093380";

(async () => {
  const body = buildSellerProductBody({
    vendorId: COUPANG_VENDOR_ID,
    vendorUserId: COUPANG_VENDOR_USER_ID,
    outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE,
    displayCategoryCode: 77723,
    sellerProductName: "[TEST] 자동업로드 최소상품",
    imageUrl: "https://via.placeholder.com/1000",
    price: 9900,
    stock: 10,
  });

  const res = await createSellerProduct({ vendorId: COUPANG_VENDOR_ID, body });

  console.log("STATUS:", res.status);
  console.log("BODY:", res.body);
})();
