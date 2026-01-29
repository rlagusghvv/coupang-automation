export function log(...args) {
  console.log("[pages]", new Date().toISOString(), ...args);
}

export function mustEnv(env, name) {
  const v = String(env[name] || "").trim();
  if (!v) throw new Error(`ENV ${name} is missing`);
  return v;
}

export function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function upsertToken(env, { kakao_user_id, refresh_token, scope }) {
  const kv = env.FRIEND_TOKENS;
  if (!kv) throw new Error("KV binding FRIEND_TOKENS is missing");

  const row = {
    kakao_user_id,
    refresh_token,
    scope: scope || "",
    saved_at: new Date().toISOString(),
  };

  await kv.put(`token:${kakao_user_id}`, JSON.stringify(row));
  return row;
}
