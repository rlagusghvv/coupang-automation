import { coupangRequest } from "../../coupang/client.js";

(async () => {
  const res = await coupangRequest({
    method: "GET",
    path: "/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/77723",
  });

  console.log("STATUS:", res.status);
  console.log("BODY:", res.body);
})();
