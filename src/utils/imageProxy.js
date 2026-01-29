function normalizeProxyBase(proxyBase) {
  const base = String(proxyBase || "").trim();
  if (!base) return base;
  try {
    const u = new URL(base);
    return u.origin;
  } catch {
    return base.replace(/\/$/, "");
  }
}

export function buildProxyUrl(rawUrl, proxyBase, referer) {
  const u = String(rawUrl || "").trim();
  if (!u) return u;

  const base = String(proxyBase || "").trim();
  if (!base) return u;

  const encoded = encodeURIComponent(u);
  const ref = String(referer || "").trim();
  const refEncoded = ref ? encodeURIComponent(ref) : "";

  let built = "";
  if (base.includes("{url}")) built = base.replace("{url}", encoded);
  else if (base.endsWith("?u=") || base.endsWith("u=")) built = base + encoded;
  else if (base.includes("?")) built = base + "&u=" + encoded;
  else built = base.replace(/\/$/, "") + "/img?u=" + encoded;

  if (!refEncoded) return built;
  return built + (built.includes("?") ? "&" : "?") + "r=" + refEncoded;
}

export async function prepareProxyUrl(rawUrl, proxyBase, referer) {
  const u = String(rawUrl || "").trim();
  if (!u) return u;

  const baseOrigin = normalizeProxyBase(proxyBase);
  if (!baseOrigin) return u;

  const params = new URLSearchParams({ u });
  if (referer) params.set("r", String(referer));

  const prepUrl = baseOrigin.replace(/\/$/, "") + "/img/prepare?" + params.toString();
  const res = await fetch(prepUrl);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.url) {
    throw new Error("image proxy prepare failed");
  }
  return String(json.url);
}
