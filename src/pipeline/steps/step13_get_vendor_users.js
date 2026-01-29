import { coupangRequest } from "../../coupang/client.js";
import { COUPANG_VENDOR_ID } from "../../config/env.js";

(async () => {
  const res = await coupangRequest({
    method: "GET",
    path: `/v2/providers/openapi/apis/api/v5/vendors/${COUPANG_VENDOR_ID}/vendor-users`,
    query: "pageNum=1&pageSize=50",
  });

  console.log("STATUS:", res.status);
  console.log("BODY:", res.body);
})();
