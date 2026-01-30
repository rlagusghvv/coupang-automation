import { coupangRequest } from "../client.js";
import { ENDPOINTS } from "../endpoints.js";

export async function getOrderSheets({
  vendorId,
  accessKey,
  secretKey,
  createdAtFrom,
  createdAtTo,
  status,
  nextToken,
  maxPerPage = 50,
  searchType,
}) {
  const qs = new URLSearchParams();
  if (createdAtFrom) qs.set("createdAtFrom", createdAtFrom);
  if (createdAtTo) qs.set("createdAtTo", createdAtTo);
  if (status) qs.set("status", status);
  if (nextToken) qs.set("nextToken", nextToken);
  if (maxPerPage) qs.set("maxPerPage", String(maxPerPage));
  if (searchType) qs.set("searchType", searchType);

  const path = ENDPOINTS.GET_ORDER_SHEETS.replace(
    "{vendorId}",
    encodeURIComponent(String(vendorId || "")),
  );

  return coupangRequest({
    method: "GET",
    path,
    query: qs.toString(),
    accessKey,
    secretKey,
  });
}
