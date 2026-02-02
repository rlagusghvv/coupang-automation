export function normalizeUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;

  // 공백/따옴표 제거
  const cleaned = s.replace(/^["']|["']$/g, "");

  // Domeggook mobile 도메인은 옵션 파싱이 불안정한 케이스가 있어
  // 가능한 경우 PC 도메인으로 정규화한다.
  // (path/query 유지)
  try {
    const parsed = new URL(cleaned);
    if (/^mobile\.domeggook\.com$/i.test(parsed.hostname)) {
      parsed.hostname = "domeggook.com";
      return parsed.toString();
    }
  } catch {
    // ignore
  }

  return cleaned;
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
