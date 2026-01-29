export async function requestHeadOrGetProbe(url, opts = {}) {
  const { timeoutMs = 15000 } = opts;

  const head = await _req(url, "HEAD", timeoutMs);
  if (head.ok) return head;

  const get = await _req(url, "GET", timeoutMs, true);
  return get;
}

async function _req(url, method, timeoutMs, useRange = false) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headersObj = {};
    if (useRange) headersObj["Range"] = "bytes=0-0";

    const res = await fetch(url, {
      method,
      redirect: "follow",
      headers: headersObj,
      signal: controller.signal,
    });

    const headers = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));

    // GET인 경우, 실제로 바디가 나오는지 1번 읽어줌(차단/HTML 리다이렉트 감지에 도움)
    if (method === "GET") {
      try {
        const reader = res.body?.getReader?.();
        if (reader) {
          await reader.read();
          try { await reader.cancel(); } catch {}
        }
      } catch {}
    }

    return { ok: res.ok, status: res.status, finalUrl: res.url, headers };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}
