import { coupangRequest } from "../../coupang/client.js";

(async () => {
  const res = await coupangRequest({
    method: "GET",
    path: "/v2/providers/marketplace_openapi/apis/api/v2/vendor/shipping-place/outbound",
    query: "pageNum=1&pageSize=50",
  });

  console.log("STATUS:", res.status);

  if (res.status !== 200) {
    console.log("BODY:", res.body);
    process.exit(1);
  }

  const json = JSON.parse(res.body);

  const places = (json.content || []).map((p) => ({
    outboundShippingPlaceCode: p.outboundShippingPlaceCode,
    shippingPlaceName: p.shippingPlaceName,
    usable: p.usable,
  }));

  console.table(places);

  const firstUsable = places.find((p) => p.usable);
  if (firstUsable) {
    console.log("PICK:", firstUsable.outboundShippingPlaceCode);
  } else {
    console.log("No usable outbound shipping place found.");
  }
})();
