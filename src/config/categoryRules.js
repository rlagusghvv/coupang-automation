// 카테고리 키워드 룰 (유지보수용)
// - keyword: 도매꾹 상품명/카테고리 텍스트에 포함될 키워드
// - code: 쿠팡 displayCategoryCode
// 우선순위: STATIC > GENERATED > ENV(JSON)

import fs from "node:fs";
import path from "node:path";

// 수동으로 고정할 룰 (가장 우선)
const STATIC_RULES = [
  // 휴대폰 보호필름
  { keyword: "보호필름", code: 62634 },
  { keyword: "액정보호", code: 62634 },
  { keyword: "필름", code: 62634 },
  { keyword: "휴대폰보호필름", code: 62634 },
];

// 자동 생성된 룰 (scripts/build_category_rules.js가 생성)
function loadGeneratedRules() {
  try {
    const p = path.join(process.cwd(), "src/config/categoryRules.generated.json");
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf-8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export const CATEGORY_RULES = [
  ...STATIC_RULES,
  ...loadGeneratedRules(),
];
