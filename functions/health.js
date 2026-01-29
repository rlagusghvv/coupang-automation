export function onRequest() {
  return new Response("OK", { headers: { "content-type": "text/plain" } });
}
