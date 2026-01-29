function parseMap() {
  const raw = (process.env.DOMEGGOOK_CATEGORY_MAP_JSON || "").trim();
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function resolveDisplayCategoryCode({ title, categoryText, fallback }) {
  const map = parseMap();
  const hay = `${title || ""} ${categoryText || ""}`.toLowerCase();

  for (const row of map) {
    const keyword = String(row?.keyword || "").trim().toLowerCase();
    const code = Number(row?.code);
    if (keyword && Number.isFinite(code) && hay.includes(keyword)) return code;
  }

  return fallback;
}
