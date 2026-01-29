import { coupangRequest } from "../../coupang/client.js";

const raw = process.argv[2] || "";
if (!raw) {
  console.log("Usage: node src/pipeline/steps/step27_validate_categories.js <code1,code2,...>");
  process.exit(1);
}

const codes = raw
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));

for (const c of codes) {
  const res = await coupangRequest({
    method: "GET",
    path: `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${c}`,
  });
  console.log("\nCODE:", c, "STATUS:", res.status);
  console.log("BODY:", res.body);
}
