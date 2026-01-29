import { coupangRequest } from "../../coupang/client.js";
import { COUPANG_VENDOR_ID } from "../../config/env.js";

(async () => {
  const path = `/v2/providers/openapi/apis/api/v5/vendors/${COUPANG_VENDOR_ID}/returnShippingCenters`;

  const res = await coupangRequest({
    method: "GET",
    path,
    query: "pageNum=1&pageSize=50",
  });

  console.log("STATUS:", res.status);

  if (res.status !== 200) {
    console.log("BODY:", res.body);
    process.exit(1);
  }

  const json = JSON.parse(res.body);

  // ✅ 문서: data가 "반품지 목록 데이터(Array)"  [oai_citation:1‡developers.coupangcorp.com](https://developers.coupangcorp.com/hc/ko/articles/360033644814-%EB%B0%98%ED%92%88%EC%A7%80-%EB%AA%A9%EB%A1%9D-%EC%A1%B0%ED%9A%8C)
  const list = Array.isArray(json?.data) ? json.data : [];

  if (list.length === 0) {
    console.log("No returnShippingCenters in API (json.data is empty).");
    // 디버그용으로 구조만 짧게 보여주기
    console.log("keys:", Object.keys(json));
    process.exit(0);
  }

  const centers = list.map((c) => ({
    returnCenterCode: c.returnCenterCode,
    shippingPlaceName: c.shippingPlaceName,
    usable: c.usable,
    deliverName: c.deliverName,
    goodsflowStatus: c.goodsflowStatus,
  }));

  console.table(centers);

  const pick = centers.find((c) => c.usable === true) || centers[0];
  console.log("PICK:", pick.returnCenterCode);
})();
