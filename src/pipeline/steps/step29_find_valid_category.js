import { coupangRequest } from "../../coupang/client.js";

const keyword = (process.argv[2] || "").trim().toLowerCase();
if (!keyword) {
  console.log("Usage: node src/pipeline/steps/step29_find_valid_category.js <keyword>");
  process.exit(1);
}

const treeRes = await coupangRequest({
  method: "GET",
  path: "/v2/providers/seller_api/apis/api/v1/marketplace/meta/display-categories",
});

if (treeRes.status !== 200) {
  console.log("TREE STATUS:", treeRes.status);
  console.log("TREE BODY:", treeRes.body);
  process.exit(1);
}

let tree = {};
try {
  tree = typeof treeRes.body === "string" ? JSON.parse(treeRes.body) : treeRes.body;
} catch {}

const candidates = [];
const stack = [{ node: tree.data, path: "ROOT" }];
while (stack.length) {
  const { node, path } = stack.pop();
  if (!node) continue;
  const name = String(node.name || "");
  const code = node.displayItemCategoryCode;
  if (name.toLowerCase().includes(keyword)) {
    candidates.push({ code, name, path });
  }
  const ch = node.child || [];
  for (const c of ch) {
    stack.push({ node: c, path: path + " > " + (c.name || "") });
  }
}

if (!candidates.length) {
  console.log("No candidates found.");
  process.exit(0);
}

console.log("Candidates:", candidates.length);

const valid = [];
const maxValid = Number(process.env.MAX_VALID || 50);

for (const c of candidates) {
  const res = await coupangRequest({
    method: "GET",
    path: `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${c.code}`,
  });
  if (res.status === 200) valid.push(c);
  if (valid.length >= maxValid) break;
}

if (!valid.length) {
  console.log("No valid category found for keyword.");
  process.exit(0);
}

console.log("Valid matches:");
for (const v of valid) {
  console.log(`${v.code} | ${v.path}`);
}
