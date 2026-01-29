// step9_build_payload.js
// 목적: out/step8_variants_v3.json을 읽어서
//      쿠팡 상품 생성 API에 보낼 payload(JSON)를 만들어 out/step9_payload.json에 저장
//      (아직 API 호출 X = 드라이런)

const fs = require("fs");
const path = require("path");

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

// 가격 계산: 판매가 = (공급가 * 마진율) + 고정비 + 옵션추가금
function calcSalePrice(supplyPrice, priceDelta, pricing) {
  const raw =
    supplyPrice * pricing.marginRate + pricing.fixedFee + (priceDelta || 0);
  const roundTo = pricing.roundTo || 1;
  // 10원 단위 반올림 예: roundTo=10
  const rounded = Math.round(raw / roundTo) * roundTo;
  return Math.max(0, Math.trunc(rounded));
}

function makeExternalSku(base, v) {
  // 쿠팡에서 sku 식별용. 너무 길면 잘라야 할 수 있어 간단히 구성.
  const color = v.color || "NA";
  const size = v.size || "NA";
  return `${base}-${color}-${size}`.slice(0, 50);
}

(async () => {
  const config = loadJson("config.json");
  const step8 = loadJson(path.join("out", "step8_variants_v3.json"));

  // 지금은 “상품 생성 payload”의 핵심 뼈대만 만든다.
  // 실제 등록에는 출고지/반품지, 카테고리, 고시정보 등 필수값이 더 필요함. :contentReference[oaicite:3]{index=3}
  // 그래서 9-2 단계에서 “필수값 자동 채우기 템플릿”을 연결할 예정.

  // 테스트용으로 1개 상품만 먼저 payload로 만들자(원하면 전체로 쉽게 확장)
  const first = step8[0];
  if (!first) {
    console.log("step8 데이터가 비었습니다.");
    return;
  }

  const supply = first.supplyPrice;
  const variants = first.variants;

  // 옵션 조합(SKU) 만들기
  // B안: 각 variant가 쿠팡의 item(옵션) 후보
  const items = variants.map((v, idx) => {
    const salePrice = calcSalePrice(supply, v.priceDelta, config.pricing);

    return {
      // 쿠팡 payload 필드명은 실제 가이드에 맞춰야 하므로,
      // 여기서는 우리가 쓰기 편한 "중간 형식"으로 만든다(=internalPayload).
      idx: idx + 1,
      optionText: v.optionText,
      attributes: {
        COLOR: v.color,
        SIZE: v.size,
      },
      supplyPrice: supply,
      priceDelta: v.priceDelta,
      salePrice,
      stock: config.inventory.defaultStock,
      externalVendorSku: makeExternalSku("HHO", v),
    };
  });

  const internalPayload = {
    sourceUrl: first.url,
    pricing: config.pricing,
    items,
  };

  const outPath = path.join("out", "step9_payload.json");
  fs.writeFileSync(outPath, JSON.stringify(internalPayload, null, 2), "utf-8");
  console.log("드라이런 payload 저장:", outPath);
  console.log("예시 item 1개:", items[0]);
})();
