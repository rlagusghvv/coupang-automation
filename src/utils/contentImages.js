import { buildProxyUrl } from "./imageProxy.js";

function normalizeImgSrc(src) {
  let s = String(src || "").trim();
  if (!s) return "";

  // HTML entity decode for common URL characters
  s = s
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"');

  return s;
}

export function extractImageUrls(html) {
  const out = [];
  if (!html) return out;

  const re = /<img[^>]+src=["']?([^"' >]+)["']?/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = normalizeImgSrc(m[1]);
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

export function replaceImageSrcs(html, urlMap) {
  if (!html) return html;
  return String(html).replace(/<img([^>]+)src=["']?([^"' >]+)["']?([^>]*)>/gi, (m, pre, src, post) => {
    const key = normalizeImgSrc(src);
    const replaced = urlMap[key] || urlMap[src] || key || src;
    return `<img${pre}src="${replaced}"${post}>`;
  });
}
