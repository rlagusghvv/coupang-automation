function isAllowedHost(hostname) {
  return hostname === "domeggook.com" || hostname.endsWith(".domeggook.com");
}

function toBase64Url(buf) {
  const b64 = btoa(String.fromCharCode(...buf));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const u = String(url.searchParams.get("u") || "").trim();
  const r = String(url.searchParams.get("r") || "").trim();

  if (!u) {
    return new Response(JSON.stringify({ error: "missing u" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let target;
  try {
    target = new URL(u);
  } catch {
    return new Response(JSON.stringify({ error: "invalid url" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!/^https?:$/i.test(target.protocol)) {
    return new Response(JSON.stringify({ error: "invalid protocol" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!isAllowedHost(target.hostname)) {
    return new Response(JSON.stringify({ error: "forbidden host" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  if (!env.IMAGE_URL_MAP) {
    return new Response(JSON.stringify({ error: "missing kv" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const enc = new TextEncoder().encode(u);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  const id = toBase64Url(new Uint8Array(digest)).slice(0, 16);

  const payload = JSON.stringify({ u, r });
  await env.IMAGE_URL_MAP.put(id, payload, { expirationTtl: 60 * 60 * 24 * 7 });

  const origin = new URL(request.url).origin;
  const shortUrl = `${origin}/img/${id}`;

  return new Response(JSON.stringify({ id, url: shortUrl }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
