import { coupangRequest } from "../../coupang/client.js";

const keyword = (process.argv[2] || "").trim();
const startId = Number(process.argv[3] || 0);
const maxNodes = Number(process.env.MAX_NODES || 2000);

if (!keyword) {
  console.log("Usage: node src/pipeline/steps/step25_find_category.js <keyword> [startId]");
  process.exit(1);
}

async function fetchChildren(parentId) {
  const res = await coupangRequest({
    method: "GET",
    path: `/v2/providers/seller_api/apis/api/v1/marketplace/meta/display-categories/${parentId}`,
  });
  let json = {};
  try {
    json = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
  } catch {}

  const list = Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.data?.content)
      ? json.data.content
      : Array.isArray(json?.content)
        ? json.content
        : [];

  return list.map((c) => ({
    id: c.displayCategoryCode ?? c.displayCategoryId ?? c.id ?? c.code,
    name: c.displayCategoryName ?? c.name ?? c.categoryName ?? "",
    raw: c,
  }));
}

function norm(s) {
  return String(s || "").toLowerCase();
}

const matches = [];
const queue = [{ id: startId, path: String(startId) }];
const visited = new Set();

let processed = 0;
const target = norm(keyword);

while (queue.length && processed < maxNodes) {
  const node = queue.shift();
  const id = Number(node.id);
  if (!Number.isFinite(id) || visited.has(id)) continue;
  visited.add(id);

  const children = await fetchChildren(id);
  processed += 1;

  for (const child of children) {
    const name = String(child.name || "");
    const path = node.path === "0" ? name : node.path + " > " + name;

    if (norm(name).includes(target)) {
      matches.push({ id: child.id, name, path });
    }

    if (child.id != null) {
      queue.push({ id: child.id, path });
    }
  }
}

if (!matches.length) {
  console.log("No matches found.");
} else {
  console.log("Matches:");
  for (const m of matches.slice(0, 50)) {
    console.log(`${m.id} | ${m.path}`);
  }
  if (matches.length > 50) console.log(`... ${matches.length - 50} more`);
}
