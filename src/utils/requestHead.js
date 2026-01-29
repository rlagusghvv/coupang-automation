/**
 * HEAD 요청으로 이미지 여부/용량 등을 확인.
 * redirect 따라가서 최종 URL도 얻는다.
 */
export async function requestBinaryHead(url, opts = {}) {
  const { timeoutMs = 15000 } = opts;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });

    // 일부 서버는 HEAD를 막음 -> ok=false로 내보내고 상위에서 GET fallback 붙일 수 있음
    const headers = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));

    // Node fetch는 최종 URL을 res.url에 담는다
    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url,
      headers,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}
