import { coupangRequest } from "../../coupang/client.js";

const keyword = (process.argv[2] || "").trim().toLowerCase();
if (!keyword) {
  console.log("Usage: node src/pipeline/steps/step28_find_category_from_list.js <keyword>");
  process.exit(1);
}

const res = await coupangRequest({
  method: "GET",
  path: "/v2/providers/seller_api/apis/api/v1/marketplace/meta/display-categories",
});

if (res.status !== 200) {
  console.log("STATUS:", res.status);
  console.log("BODY:", res.body);
  process.exit(1);
}

let json = {};
try {
  json = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
} catch {}

const list = Array.isArray(json?.data) ? json.data : [];

const matches = list.filter((c) =>
  String(c?.name || "").toLowerCase().includes(keyword),
);

if (!matches.length) {
  console.log("No matches found.");
  process.exit(0);
}

console.log("Matches:");
for (const m of matches.slice(0, 100)) {
  console.log(`${m.displayCategoryCode} | ${m.name}`);
}
