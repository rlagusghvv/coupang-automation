export function buildProxyUrl(rawUrl, proxyBase) {
  const u = String(rawUrl || "").trim();
  if (!u) return u;

  const base = String(proxyBase || "").trim();
  if (!base) return u;

  const encoded = encodeURIComponent(u);

  if (base.includes("{url}")) return base.replace("{url}", encoded);
  if (base.endsWith("?u=") || base.endsWith("u=")) return base + encoded;
  if (base.includes("?")) return base + "&u=" + encoded;
  return base.replace(/\/$/, "") + "/img?u=" + encoded;
}
