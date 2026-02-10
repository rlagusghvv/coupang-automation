// net_limit.js
// Tiny in-process limiter + retry helpers for hostile endpoints.

const _hostNextFreeAt = new Map();

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withHostSpacing(host, spacingMs, fn) {
  const h = String(host || '').trim() || 'default';
  const gap = Math.max(0, Number(spacingMs) || 0);

  const t0 = nowMs();
  const freeAt = _hostNextFreeAt.get(h) || 0;
  const wait = Math.max(0, freeAt - t0);
  if (wait > 0) await sleep(wait);

  // Reserve next slot *before* executing (prevents stampede)
  _hostNextFreeAt.set(h, nowMs() + gap);

  return fn();
}

export async function fetchWithRetry(url, opts = {}) {
  const u = String(url || '');
  const host = (() => {
    try {
      return new URL(u).host;
    } catch {
      return 'default';
    }
  })();

  const spacingMs = Math.max(0, Number(opts?.spacingMs) || 0);
  const retries = Math.max(0, Math.min(6, Number(opts?.retries ?? 3)));
  const retryOn = Array.isArray(opts?.retryOn) ? opts.retryOn : [429, 503];
  const baseDelayMs = Math.max(50, Number(opts?.baseDelayMs || 600));
  const maxDelayMs = Math.max(baseDelayMs, Number(opts?.maxDelayMs || 8000));

  const doFetch = async () => {
    // NOTE: node18+ fetch exists. Caller may pass signal.
    return fetch(u, opts);
  };

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await withHostSpacing(host, spacingMs, doFetch);
      if (!retryOn.includes(res.status) || attempt >= retries) return res;

      // Backoff with jitter
      const pow = Math.min(10, attempt);
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, pow));
      const jitter = Math.floor(Math.random() * 250);
      await sleep(delay + jitter);
      continue;
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) throw e;
      const pow = Math.min(10, attempt);
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, pow));
      const jitter = Math.floor(Math.random() * 250);
      await sleep(delay + jitter);
    }
  }

  if (lastErr) throw lastErr;
  throw new Error('fetch_failed');
}
