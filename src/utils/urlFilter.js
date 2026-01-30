export function normalizeUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  // 공백/따옴표 제거
  return s.replace(/^["']|["']$/g, "");
}

export function classifyUrl(u) {
  const url = normalizeUrl(u);
  if (!url) return { ok: false, reason: "EMPTY", url: null };

  // MVP: domeggook.com만
  const isDomeggook = url.includes("domeggook.com");
  if (!isDomeggook) return { ok: false, reason: "NOT_DOMEGGOOK", url };

  // 1688 도매꾹도 허용
  if (url.includes("1688.domeggook.com")) return { ok: true, reason: "OK_1688", url };

  // 일반 상품 URL 패턴(최소 조건): domeggook.com/숫자 형태가 많음
  // (도매꾹은 다양한 URL이 있어 최소 조건으로만 체크)
  return { ok: true, reason: "OK", url };
}
