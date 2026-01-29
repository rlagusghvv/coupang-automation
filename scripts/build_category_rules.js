// 카테고리 자동 룰 생성기
// 목적: 도매꾹 카테고리 키워드 목록을 넣으면,
//       쿠팡 "유효한 displayCategoryCode"로 매칭된 룰을 자동 생성한다.
//
// 사용 예시:
//   node scripts/build_category_rules.js data/domeggook_categories.txt
//
// 결과:
//   src/config/categoryRules.generated.json
//
// 참고:
// - 쿠팡 카테고리 트리: /marketplace/meta/display-categories
// - 쿠팡 카테고리 메타: /marketplace/meta/category-related-metas/display-category-codes/{code}

import fs from "node:fs";
import path from "node:path";
import { coupangRequest } from "../src/coupang/client.js";

const inputPath = process.argv[2] || "data/domeggook_categories.txt";
const outputPath = path.join(process.cwd(), "src/config/categoryRules.generated.json");

function readKeywords(p) {
  if (!fs.existsSync(p)) {
    console.log("Keyword file not found:", p);
    process.exit(1);
  }
  const raw = fs.readFileSync(p, "utf-8");
  const list = raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  // 중복 제거
  return Array.from(new Set(list));
}

function flattenTree(root) {
  const out = [];
  const stack = [{ node: root, path: "ROOT" }];
  while (stack.length) {
    const { node, path: p } = stack.pop();
    if (!node) continue;
    const name = String(node.name || "");
    const code = node.displayItemCategoryCode;
    const pathStr = p === "ROOT" ? name : p + " > " + name;
    out.push({ name, code, path: pathStr });
    const child = node.child || [];
    for (const c of child) {
      stack.push({ node: c, path: pathStr });
    }
  }
  return out;
}

async function isValidCode(code) {
  const res = await coupangRequest({
    method: "GET",
    path: `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${code}`,
  });
  return res.status === 200;
}

function preferByPath(candidates) {
  const prefer = (process.env.CATEGORY_PREFERRED_PATH_INCLUDES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!prefer.length) return candidates;

  return candidates.sort((a, b) => {
    const aScore = prefer.reduce((acc, k) => acc + (a.path.includes(k) ? 1 : 0), 0);
    const bScore = prefer.reduce((acc, k) => acc + (b.path.includes(k) ? 1 : 0), 0);
    return bScore - aScore;
  });
}

(async () => {
  const keywords = readKeywords(inputPath);
  console.log("Keywords:", keywords.length);

  const treeRes = await coupangRequest({
    method: "GET",
    path: "/v2/providers/seller_api/apis/api/v1/marketplace/meta/display-categories",
  });

  if (treeRes.status !== 200) {
    console.log("Failed to fetch category tree:", treeRes.status);
    console.log(treeRes.body);
    process.exit(1);
  }

  const tree = JSON.parse(treeRes.body);
  const flat = flattenTree(tree.data);

  const rules = [];

  for (const kw of keywords) {
    const target = kw.toLowerCase();
    const candidates = flat.filter((c) => String(c.name || "").toLowerCase().includes(target));
    if (!candidates.length) continue;

    const sorted = preferByPath(candidates);
    let chosen = null;

    for (const c of sorted) {
      if (await isValidCode(c.code)) {
        chosen = c;
        break;
      }
    }

    if (chosen) {
      rules.push({ keyword: kw, code: Number(chosen.code), path: chosen.path });
      console.log("OK:", kw, "->", chosen.code, "|", chosen.path);
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(rules, null, 2), "utf-8");
  console.log("Saved:", outputPath, "rules:", rules.length);
})();
