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

export async function onRequest({ params, env }) {
  const id = String(params.id || "").trim();
  if (!id) {
    return new Response("missing id", { status: 400, headers: { "content-type": "text/plain" } });
  }

  if (!env.IMAGE_URL_MAP) {
    return new Response("missing kv", { status: 500, headers: { "content-type": "text/plain" } });
  }

  const raw = await env.IMAGE_URL_MAP.get(id);
  if (!raw) {
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  }

  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    return new Response("bad mapping", { status: 500, headers: { "content-type": "text/plain" } });
  }

  const target = String(data.u || "").trim();
  const referer = String(data.r || "").trim();
  if (!target) {
    return new Response("bad mapping", { status: 500, headers: { "content-type": "text/plain" } });
  }

  const attempts = [
    { url: target, referer },
    { url: target, referer: "" },
  ];
  if (target.startsWith("https://")) {
    const httpUrl = "http://" + target.slice("https://".length);
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
}
