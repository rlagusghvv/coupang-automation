const PROMO_CONTAINER_RE = /<(div|section|article|table)[^>]+(?:id|class)=["'][^"']*(?:aitems?recommend|categoryswiper|aiswiper|recommend(?:ation)?|related)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;
const CATALOG_BLOCK_RE = /<!--\s*\[ST\]catalog\s*-->[\s\S]*?<!--\s*\[ED\]catalog\s*-->/gi;

const PROMO_TEXT_MARKERS = [
  /상품\s*공급사\s*추천\s*상품/i,
  /함께\s*사면\s*더\s*좋은\s*상품/i,
  /카테고리에서\s*주목할\s*상품/i,
  /꾹\s*ai\s*:?\s*추천/i,
];

function countTag(text, tagName) {
  const re = new RegExp(`<${String(tagName || "").replace(/[^a-z0-9_-]/gi, "")}\\b`, "gi");
  const m = String(text || "").match(re);
  return m ? m.length : 0;
}

function countDomeggookProductLinks(text) {
  const m = String(text || "").match(/https?:\/\/(?:www\.)?domeggook\.com\/\d{6,}/gi);
  return m ? m.length : 0;
}

export function stripDomeggookPromoBlocks(html) {
  let out = String(html || "");
  if (!out) return out;

  out = out.replace(CATALOG_BLOCK_RE, "");
  out = out.replace(PROMO_CONTAINER_RE, "");

  let cutIndex = -1;
  for (const marker of PROMO_TEXT_MARKERS) {
    marker.lastIndex = 0;
    const hit = marker.exec(out);
    if (!hit) continue;
    if (cutIndex < 0 || hit.index < cutIndex) cutIndex = hit.index;
  }
  if (cutIndex >= 0) {
    const before = out.slice(0, cutIndex);
    const after = out.slice(cutIndex);
    const imagesBefore = countTag(before, "img");
    const imagesAfter = countTag(after, "img");
    const productLinksAfter = countDomeggookProductLinks(after);

    if (imagesBefore >= 1 && (imagesAfter >= 3 || productLinksAfter >= 3)) {
      return before;
    }
  }

  const navMarkers = Array.from(
    out.matchAll(/data-focus\s*=\s*["']#nav_\d+_idx["']/gi),
  );
  if (navMarkers.length >= 8 && countDomeggookProductLinks(out) >= 8) {
    const firstNavIndex = Number(navMarkers[0]?.index || 0);
    if (firstNavIndex > 0 && countTag(out.slice(0, firstNavIndex), "img") >= 1) {
      const cutFromDiv = out.lastIndexOf("<div", firstNavIndex);
      const cutIndexByNav = cutFromDiv > 0 ? cutFromDiv : firstNavIndex;
      return out.slice(0, cutIndexByNav);
    }
  }

  return out;
}
