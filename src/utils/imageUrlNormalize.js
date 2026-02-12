// Utilities for normalizing image URLs, especially Domeggook/Domaeqq quirks.

export function normalizeUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  if (s.startsWith("//")) return `https:${s}`;
  return s;
}

function safeDecodeURIComponent(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Some Domeggook/OpenAPI responses include fields like `thumbOriginal` that can be:
 * - a protocol-relative URL (//...)
 * - a URL-encoded URL embedded inside another URL's query param
 * - a partial path
 *
 * This attempts to extract the most-likely original image URL.
 */
export function normalizeDomeggookThumbOriginalUrl(input) {
  const u = normalizeUrl(input);
  if (!u) return null;

  // If it already looks like an image URL, keep it.
  if (/^https?:\/\//i.test(u) && /\.(jpe?g|png|webp|gif|bmp|svg)(\?|#|$)/i.test(u)) {
    return u;
  }

  // If a URL contains a nested URL in common parameters.
  // Examples (approx): ...?thumbOriginal=http%3A%2F%2F... or ...?url=https%3A%2F%2F...
  try {
    const parsed = new URL(u);
    const candidates = [
      parsed.searchParams.get("thumbOriginal"),
      parsed.searchParams.get("thumb_original"),
      parsed.searchParams.get("original"),
      parsed.searchParams.get("origin"),
      parsed.searchParams.get("url"),
      parsed.searchParams.get("src"),
      parsed.searchParams.get("image"),
    ].filter(Boolean);

    for (const cand of candidates) {
      const decoded = normalizeUrl(safeDecodeURIComponent(cand));
      if (decoded && /^https?:\/\//i.test(decoded)) return decoded;
      if (decoded && decoded.startsWith("/")) return `${parsed.origin}${decoded}`;
      if (decoded && decoded.startsWith("//")) return `https:${decoded}`;
    }
  } catch {
    // ignore
  }

  // Protocol upgrade fallback
  if (u.startsWith("http://")) return `https://${u.slice("http://".length)}`;
  return u;
}

export function expandCandidateImageUrls(imageUrl) {
  const base = normalizeDomeggookThumbOriginalUrl(imageUrl);
  if (!base) return [];

  const list = [base];

  // Try https variant
  if (base.startsWith("http://")) list.push(`https://${base.slice("http://".length)}`);

  // Some image servers accept removing querystring.
  try {
    const u = new URL(base);
    if (u.search) {
      const noQuery = `${u.origin}${u.pathname}`;
      list.push(noQuery);
    }
  } catch {}

  return Array.from(new Set(list)).filter(Boolean);
}
