import { log } from "./_lib.js";

export function onRequest({ request }) {
  try {
    const url = new URL(request.url);
    const u = String(url.searchParams.get("u") || "").trim();
    if (!u) {
      return new Response("missing u", { status: 400, headers: { "content-type": "text/plain" } });
    }

    let decoded = "";
    try {
      decoded = decodeURIComponent(u);
    } catch {
      return new Response("invalid url", { status: 400, headers: { "content-type": "text/plain" } });
    }

    if (!/^https?:\/\//i.test(decoded)) {
      return new Response("invalid url", { status: 400, headers: { "content-type": "text/plain" } });
    }

    log("[go] redirect", decoded);
    return Response.redirect(decoded, 302);
  } catch (e) {
    log("[go] error", e?.message);
    return new Response("go error", { status: 500, headers: { "content-type": "text/plain" } });
  }
}
