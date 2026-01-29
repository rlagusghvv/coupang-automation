/**
 * step9_call_coupang_api_v2.js
 *
 * 목적:
 * 1) 쿠팡 Open API 호출 준비(서명 생성 + 헤더 구성)
 * 2) 지금 발생한 "ByteString(헤더에 한글/특수문자)" 문제를 정확히 잡아낸다
 * 3) DRY RUN(실제 호출 없이) 모드로도 테스트 가능
 *
 * 사용법:
 * - DRY RUN(추천):  node step9_call_coupang_api_v2.js --dry
 * - 실제 호출:      node step9_call_coupang_api_v2.js
 *
 * 준비:
 * - .env 파일에 아래 3개를 넣어두면 됨(따옴표 없이, 공백 없이)
 *   COUPANG_ACCESS_KEY=...
 *   COUPANG_SECRET_KEY=...
 *   COUPANG_VENDOR_ID=...
 *
 * - 실제 키가 아직 없으면, --dry로 실행하면 "요청이 어떻게 만들어지는지"까지만 확인 가능
 */

require("dotenv").config();
const crypto = require("crypto");

// ------------------------- 0) 실행 옵션 -------------------------
const IS_DRY_RUN = process.argv.includes("--dry");

// ------------------------- 1) 환경변수 로드 -------------------------
const ACCESS_KEY = process.env.COUPANG_ACCESS_KEY || "DUMMY_ACCESS_KEY";
const SECRET_KEY = process.env.COUPANG_SECRET_KEY || "DUMMY_SECRET_KEY";
const VENDOR_ID = process.env.COUPANG_VENDOR_ID || "DUMMY_VENDOR_ID";

// ------------------------- 2) ASCII(헤더 안전) 검사 -------------------------
// 헤더는 "영문/숫자/기호(ASCII)"만 안전합니다.
// 한글/이모지/특수문자가 섞이면 Node가 헤더로 못 넣고 지금 같은 에러가 납니다.
function assertHeaderSafeAscii(str, label) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code > 255) {
      // 문제 글자/위치/코드를 정확히 보여줌
      const ch = str[i];
      throw new Error(
        `[ASCII ERROR] ${label}에 헤더로 넣을 수 없는 문자가 포함됨: index=${i}, char="${ch}", charCode=${code}\n` +
          `→ 해결: .env 값에 한글/이모지/따옴표/이상한 공백이 섞였는지 확인`
      );
    }
  }
  return str;
}

// ------------------------- 3) 쿠팡 날짜 포맷 -------------------------
// 쿠팡 예제에서 흔히 쓰는 UTC 포맷: yyyyMMdd'T'HHmmss'Z'
function getCoupangDateTimeUTC() {
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

// ------------------------- 4) Authorization 생성 -------------------------
// 주의: 쿠팡의 "정확한 서명 문자열 구성 규칙"은 문서 샘플과 1:1로 맞춰야 합니다.
// 지금 단계 목표는 1) 헤더가 깨지지 않게 만들기 2) 401/400 응답을 실제로 받아보기 입니다.
//
// 만약 401(서명 불일치)이 나오면, 그때 쿠팡 문서 샘플과 완전히 같은 message 포맷으로 맞춰줍니다.
function generateAuthorization(method, pathWithQuery) {
  const signedDate = getCoupangDateTimeUTC();

  // 1) 헤더 안전 ASCII 검사(여기서 걸리면 .env 값 문제)
  assertHeaderSafeAscii(ACCESS_KEY, "COUPANG_ACCESS_KEY");
  assertHeaderSafeAscii(SECRET_KEY, "COUPANG_SECRET_KEY");
  assertHeaderSafeAscii(VENDOR_ID, "COUPANG_VENDOR_ID");
  assertHeaderSafeAscii(method, "HTTP_METHOD");
  assertHeaderSafeAscii(pathWithQuery, "PATH_WITH_QUERY");

  // 2) 임시 message (다음 단계에서 쿠팡 문서와 완전 동일하게 맞출 예정)
  const message = `${signedDate}${method}${pathWithQuery}`;

  // 3) HMAC-SHA256 서명
  const signature = crypto
    .createHmac("sha256", SECRET_KEY)
    .update(message, "utf8")
    .digest("hex");

  // 4) Authorization 헤더 문자열
  const auth = `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${signedDate}, signature=${signature}`;

  // 5) 헤더 안전 ASCII 최종 검사
  assertHeaderSafeAscii(auth, "Authorization");

  return auth;
}

// ------------------------- 5) 실제 호출 함수 -------------------------
async function main() {
  // 쿠팡 API 엔드포인트
  const endpoint = "https://api-gateway.coupang.com";
  const pathOnly =
    "/v2/providers/seller_api/apis/api/v1/marketplace/seller-products";

  // vendorId는 query로 붙여 호출하는 케이스가 많아 일단 유지
  const query = `?vendorId=${encodeURIComponent(VENDOR_ID)}`;
  const pathWithQuery = `${pathOnly}${query}`;

  // 헤더 생성
  const auth = generateAuthorization("POST", pathWithQuery);

  // ✅ 여기서도 헤더 값은 무조건 ASCII로만
  const headers = {
    "Content-Type": "application/json;charset=UTF-8",
    Authorization: auth,
    "X-Requested-By": "couplus-clone", // 영문만
  };

  // 바디: 지금은 "통신/인증이 되는지" 보는 단계라 최소 형태로 둠
  // 다음 단계에서 쿠팡 스키마(카테고리/이미지/출고/반품/고시정보/옵션 등)로 완성합니다.
  const body = {
    vendorId: VENDOR_ID,
  };

  // ---------------- DRY RUN ----------------
  if (IS_DRY_RUN) {
    console.log("=== DRY RUN 모드(실제 호출 없음) ===");
    console.log("URL:", `${endpoint}${pathWithQuery}`);
    console.log("Headers:");
    console.log(headers);
    console.log("Body:");
    console.log(JSON.stringify(body, null, 2));
    console.log(
      "\n다음 단계: 실제 키를 넣고(또는 --dry 없이) 실행하면 Status/Response가 출력됩니다."
    );
    return;
  }

  // ---------------- REAL CALL ----------------
  // Node 18+는 내장 fetch가 있습니다. Node v24면 확실히 존재합니다.
  const res = await fetch(`${endpoint}${pathWithQuery}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text);
}

// 실행
main().catch((e) => {
  console.log("실행 에러:", e.message);
  // e.stack이 필요하면 아래도 켜기
  // console.log(e.stack);
});
