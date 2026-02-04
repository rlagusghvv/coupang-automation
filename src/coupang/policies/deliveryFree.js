import { COUPANG_DELIVERY_COMPANY_CODE } from "../../config/env.js";

export function deliveryFree({ deliveryCompanyCode } = {}) {
  const code = String(deliveryCompanyCode || COUPANG_DELIVERY_COMPANY_CODE || "").trim();
  return {
    deliveryMethod: "SEQUENCIAL",

    // ✅ 출고지에 등록된 택배사 코드만 사용해야 함
    deliveryCompanyCode: code,

    deliveryChargeType: "FREE",
    deliveryCharge: 0,

    freeShipOverAmount: 0,

    // ✅ 도서산간 배송 OFF (MVP에서는 무조건 N)
    remoteAreaDeliverable: "N",

    // 묶음배송 안함
    unionDeliveryType: "NOT_UNION_DELIVERY",
  };
}
