import { coupangRequest } from "../client.js";
import { ENDPOINTS } from "../endpoints.js";

// Lists seller products (requires vendorId query).
// Returns {status, body} where body is raw text.
export async function listSellerProducts({ vendorId, nextToken = null, maxPerPage = 50, accessKey, secretKey }) {
  const v = String(vendorId || '').trim();
  if (!v) throw new Error('vendorId required');
  const size = Math.max(1, Math.min(50, Number(maxPerPage) || 50));

  const q = new URLSearchParams();
  q.set('vendorId', v);
  q.set('page', '1');
  q.set('size', String(size));
  if (nextToken) q.set('nextToken', String(nextToken));

  return coupangRequest({
    method: 'GET',
    path: ENDPOINTS.CREATE_SELLER_PRODUCT,
    query: q.toString(),
    accessKey,
    secretKey,
  });
}
