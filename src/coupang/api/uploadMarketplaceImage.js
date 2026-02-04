import { coupangRequest } from "../client.js";

/**
 * Upload image binary to Coupang and return vendorPath/cdnPath.
 *
 * Note: Endpoint varies by account/version, so we try multiple candidates.
 */
export async function uploadMarketplaceImage({
  vendorId,
  buffer,
  fileName = "image.jpg",
  mimeType = "image/jpeg",
  accessKey,
  secretKey,
}) {
  if (!vendorId) throw new Error("vendorId required");
  if (!buffer) throw new Error("buffer required");

  const fd = new FormData();
  const blob = new Blob([buffer], { type: mimeType });
  fd.append("image", blob, fileName);
  fd.append("file", blob, fileName);

  const candidates = [
    "/v2/providers/seller_api/apis/api/v1/marketplace/images",
    "/v2/providers/seller_api/apis/api/v1/marketplace/images/upload",
    "/v2/providers/seller_api/apis/api/v1/marketplace/vendor-inventories/images",
    "/v2/providers/seller_api/apis/api/v1/marketplace/vendor-inventories/images/upload",
  ];

  let last = null;
  for (const p of candidates) {
    const res = await coupangRequest({
      method: "POST",
      path: p,
      query: `vendorId=${encodeURIComponent(vendorId)}`,
      body: fd,
      accessKey,
      secretKey,
      // no content-type header
    });

    last = { path: p, status: res.status, body: res.body };

    if (res.status >= 200 && res.status < 300) {
      try {
        const j = JSON.parse(res.body);
        const data = j?.data || j;
        const vendorPath = data?.vendorPath || data?.path || data?.filePath;
        const cdnPath = data?.cdnPath || data?.url;
        if (vendorPath || cdnPath) {
          return {
            ok: true,
            vendorPath,
            cdnPath,
            raw: data,
            endpoint: p,
          };
        }
        // Some accounts return list
        if (Array.isArray(data) && data[0]) {
          return {
            ok: true,
            vendorPath: data[0]?.vendorPath,
            cdnPath: data[0]?.cdnPath,
            raw: data,
            endpoint: p,
          };
        }
      } catch {
        // ignore parse
      }
    }
  }

  return { ok: false, error: "upload_failed", last };
}
