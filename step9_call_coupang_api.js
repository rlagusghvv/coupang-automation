// step9_call_coupang_api.js
// 목적: 쿠팡 상품 생성 API 호출(실등록)
// - HMAC 시그니처를 만들어 Authorization 헤더에 넣는다. :contentReference[oaicite:5]{index=5}
// - 실제 상품 생성 endpoint: POST /v2/providers/seller_api/apis/api/v1/marketplace/seller-products :contentReference[oaicite:6]{index=6}
//
// 주의: 쿠팡 상품 생성은 필수 필드(카테고리/고시정보/출고지/반품지 등)가 많다. :contentReference[oaicite:7]{index=7}
//      지금 파일은 "호출 뼈대 + 인증"을 완성하고, 다음 단계에서 payload를 쿠팡 규격으로 채운다.

require("dotenv").config();
const crypto = require("crypto");

const fs = require("fs");
const path = require("path");

const ACCESS_KEY = process.env.COUPANG_ACCESS_KEY;
const SECRET_KEY = process.env.COUPANG_SECRET_KEY;
const VENDOR_ID = process.env.COUPANG_VENDOR_ID;

if (!ACCESS_KEY || !SECRET_KEY || !VENDOR_ID) {
  console.log(
    "환경변수(.env)가 비었습니다. COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY / COUPANG_VENDOR_ID 확인."
  );
  process.exit(1);
}

// 쿠팡 HMAC Signature 생성 (개념)
// - method + path(+query) + datetime 등을 조합한 message를 만들고
// - secretKey로 HMAC-SHA256 서명 후 base64
// - 결과를 Authorization 헤더에 넣는다. :contentReference[oaicite:8]{index=8}
function getCoupangDateTime() {
  // 쿠팡 예제들은 보통 yyyyMMdd'T'HHmmss'Z' 형태(UTC)를 사용
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const MM = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const HH = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}${MM}${dd}T${HH}${mm}${ss}Z`;
}

function generateAuthorization(method, pathWithQuery) {
  const datetime = getCoupangDateTime();

  // 쿠팡 Open API의 HMAC 생성 규칙은 공식 가이드의 포맷을 따라야 한다. :contentReference[oaicite:9]{index=9}
  // 여기서는 “표준 구현 뼈대”를 제공하고,
  // 다음 단계에서 너의 실제 문서/가이드 포맷(샘플)과 1:1로 맞춰 검증한다.

  // message 구성(일반적으로 method + path + datetime 조합)
  const message = `${datetime}${method}${pathWithQuery}`;

  const signature = crypto
    .createHmac("sha256", SECRET_KEY)
    .update(message)
    .digest("hex");

  // Authorization 헤더 포맷도 가이드에 맞춰야 한다. :contentReference[oaicite:10]{index=10}
  // 흔한 형태: "CEA algorithm=HmacSHA256, access-key=..., signed-date=..., signature=..."
  return `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`;
}

(async () => {
  const endpoint = "https://api-gateway.coupang.com";
  const pathOnly =
    "/v2/providers/seller_api/apis/api/v1/marketplace/seller-products";
  const query = `?vendorId=${encodeURIComponent(VENDOR_ID)}`;
  const pathWithQuery = `${pathOnly}${query}`;

  // 지금은 step9_payload.json은 "중간형식"이라서 그대로 보내면 쿠팡이 거절함.
  // 따라서 우선은 “인증 + 호출 구조”만 검증하기 위해,
  // 아주 최소한의 dummy body로 호출해 보고 에러 메시지를 확인(다음 단계에서 필드 채움)
  // (쿠팡 문서: 상품 생성 시 카테고리/출고지/반품지/고시정보/옵션 등 필요) :contentReference[oaicite:11]{index=11}
  const body = {
    vendorId: VENDOR_ID,
    // TODO: 다음 단계에서 쿠팡 요구 스키마로 완성
    // categoryId, items, shipping, returnCenter, noticeCategories, images, etc...
  };

  const auth = generateAuthorization("POST", pathWithQuery);

  const res = await fetch(`${endpoint}${pathWithQuery}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: auth,
      // 쿠팡 문서에서 X-Requested-By 헤더를 요구하는 경우가 있다. :contentReference[oaicite:12]{index=12}
      "X-Requested-By": "couplus-clone",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text);
})();
