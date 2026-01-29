function sniffImageType(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf.length >= 12 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image/webp";
  return null;
}

function isAllowedHost(hostname) {
  return (
    hostname === "domeggook.com" ||
    hostname.endsWith(".domeggook.com") ||
    hostname.endsWith(".domeggook.com:443")
  );
}

export async function onRequest({ request }) {
  try {
    const url = new URL(request.url);
    const u = String(url.searchParams.get("u") || "").trim();
    const r = String(url.searchParams.get("r") || "").trim();
    if (!u) {
      return new Response("missing u", { status: 400, headers: { "content-type": "text/plain" } });
    }

    let target;
    try {
      target = new URL(u);
    } catch {
      return new Response("invalid url", { status: 400, headers: { "content-type": "text/plain" } });
    }

    if (!/^https?:$/i.test(target.protocol)) {
      return new Response("invalid protocol", { status: 400, headers: { "content-type": "text/plain" } });
    }

    if (!isAllowedHost(target.hostname)) {
      return new Response("forbidden host", { status: 403, headers: { "content-type": "text/plain" } });
    }

    const referer = r && /^https?:\/\//i.test(r) ? r : "https://domeggook.com/";

    const attempts = [
      { url: target.toString(), referer },
      { url: target.toString(), referer: "" },
    ];
    if (target.protocol === "https:") {
      const httpUrl = "http://" + target.host + target.pathname + target.search;
      attempts.push({ url: httpUrl, referer });
      attempts.push({ url: httpUrl, referer: "" });
    }

    let res = null;
    for (const a of attempts) {
      res = await fetch(a.url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          ...(a.referer ? { "Referer": a.referer } : {}),
        },
      });
      if (res.ok) break;
    }

    if (!res.ok) {
      return new Response(`upstream ${res.status}`, {
        status: res.status,
        headers: { "content-type": "text/plain" },
      });
    }

    const ab = await res.arrayBuffer();
    const buf = new Uint8Array(ab);
    const sniff = sniffImageType(buf);
    const ct = sniff || res.headers.get("content-type") || "application/octet-stream";

    return new Response(ab, {
      status: 200,
      headers: {
        "content-type": ct,
        "cache-control": "public, max-age=604800, immutable",
      },
    });
  } catch (e) {
    return new Response("proxy error", { status: 500, headers: { "content-type": "text/plain" } });
  }
}
