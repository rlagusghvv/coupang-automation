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
