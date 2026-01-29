import { coupangRequest } from "../../coupang/client.js";

const parentId = Number(process.argv[2] || 0);
if (!Number.isFinite(parentId)) {
  console.log("Usage: node src/pipeline/steps/step26_list_categories.js [parentId]");
  process.exit(1);
}

const res = await coupangRequest({
  method: "GET",
  path: `/v2/providers/seller_api/apis/api/v1/marketplace/meta/display-categories/${parentId}`,
});

console.log("STATUS:", res.status);
console.log("BODY:", res.body);
