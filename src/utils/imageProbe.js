function sniffImageByMagic(buf) {
  if (!buf || buf.length < 4) return false;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;

  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;

  // GIF: 47 49 46
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;

  // WEBP: "RIFF"...."WEBP"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf.length >= 12 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true;

  return false;
}

async function probeOnce(url) {
  // HEAD는 도매꾹 쪽에서 404/차단 잘 나옴 => GET으로 아주 조금만 받아서 확인
  const res = await fetch(url, {
    method: "GET",
    headers: {
      // 도매꾹 계열은 Referer 없으면 막는 경우가 있어 넣어줌
      "Referer": "https://domeggook.com/",
      "User-Agent": "Mozilla/5.0",
      "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "Range": "bytes=0-4095",
    },
    redirect: "follow",
  });

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const finalUrl = res.url;

  if (!res.ok) {
    return { ok: false, status: res.status, finalUrl, contentType: ct };
  }

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);

  const looksImage =
    ct.startsWith("image/") ||
    sniffImageByMagic(buf) ||
    // 도매꾹이 octet-stream으로 주는 케이스를 허용
    ct.includes("application/octet-stream") && sniffImageByMagic(buf);

  if (!looksImage) {
    return { ok: false, status: res.status, finalUrl, contentType: ct, reason: "NOT_IMAGE" };
  }

  return { ok: true, status: res.status, finalUrl, contentType: ct };
}

export async function probeImageUrl(url) {
  try {
    const u = String(url).trim();
    if (!/^https?:\/\//i.test(u)) {
      return { ok: false, reason: "BAD_URL", debug: { url: u } };
    }

    // 1) 그대로 시도
    const a = await probeOnce(u);
    if (a.ok) return { ok: true, finalUrl: a.finalUrl, contentType: a.contentType };

    // 2) https -> http fallback (도매꾹/쿠팡 조합에서 가끔 이게 살아남)
    if (u.startsWith("https://")) {
      const httpUrl = "http://" + u.slice("https://".length);
      const b = await probeOnce(httpUrl);
      if (b.ok) return { ok: true, finalUrl: b.finalUrl, contentType: b.contentType };
      return { ok: false, reason: "PROBE_FAILED", debug: { first: a, second: b } };
    }

    return { ok: false, reason: "PROBE_FAILED", debug: { first: a } };
  } catch (e) {
    return { ok: false, reason: "PROBE_ERROR", debug: { error: String(e) } };
  }
}
