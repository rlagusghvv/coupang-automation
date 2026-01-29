import { buildProxyUrl } from "./imageProxy.js";

export function extractImageUrls(html) {
  const out = [];
  if (!html) return out;

  const re = /<img[^>]+src=["']?([^"' >]+)["']?/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = String(m[1] || "").trim();
    if (!src) continue;
    if (!/^https?:\/\//i.test(src)) continue;
    if (!out.includes(src)) out.push(src);
  }
  return out;
}

export function buildImageOnlyHtml(imageUrls, proxyBase, referer) {
  if (!imageUrls || imageUrls.length === 0) return "";
  return imageUrls
    .map((u) => `<p><img src="${buildProxyUrl(u, proxyBase, referer)}" /></p>`)
    .join("");
}

export function buildImageOnlyHtmlFromUrls(imageUrls) {
  if (!imageUrls || imageUrls.length === 0) return "";
  return imageUrls.map((u) => `<p><img src="${u}" /></p>`).join("");
}

export function filterDomeggookUrls(urls) {
  if (!urls || urls.length === 0) return [];
  return urls.filter((u) => /https?:\/\/([^/]*\.)?domeggook\.com\//i.test(String(u)));
}
