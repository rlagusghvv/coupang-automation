export function toCoupangImageUrl(rawUrl) {
  if (!rawUrl) return rawUrl;

  const u = String(rawUrl).trim();
  const abs = u.startsWith("//") ? "https:" + u : u;

  // weserv는 원본이 octet-stream이어도 강제로 이미지로 변환해서 내려줄 수 있음
  // output=jpg 로 "image/jpeg" 확률을 최대화
  const withoutScheme = abs.replace(/^https?:\/\//, "");
  return `https://images.weserv.nl/?url=${encodeURIComponent(withoutScheme)}&output=jpg`;
}
