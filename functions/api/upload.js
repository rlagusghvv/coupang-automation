// Cloudflare Pages Function: /api/upload
// 역할: 프론트에서 받은 도매꾹 URL을 "업로드 실행기"로 전달하는 얇은 프록시
// 주의: Pages/Workers 런타임에서는 Playwright 실행이 불가하므로,
//       실제 업로드 로직은 별도 Node 서버(예: VPS)에서 처리해야 함.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }

  const url = String(body?.url || "").trim();
  if (!url) return json({ ok: false, error: "missing url" }, 400);

  const uploader = String(env.UPLOADER_URL || "").trim();
  if (!uploader) {
    return json({ ok: false, error: "UPLOADER_URL not set" }, 500);
  }

  const res = await fetch(uploader, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });

  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  return json({ ok: res.ok, upstreamStatus: res.status, result: payload }, res.ok ? 200 : 502);
}
