export function toCoupangImageUrl(rawUrl) {
  if (!rawUrl) return rawUrl;

  const u = String(rawUrl).trim();
  const withoutScheme = u.replace(/^https?:\/\//, "");
  // wsrv.nl은 url= 인코딩 방식이 더 단순하게 통하는 케이스가 많음
  return `https://wsrv.nl/?url=${encodeURIComponent(withoutScheme)}`;
}
