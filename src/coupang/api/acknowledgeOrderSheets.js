import { coupangRequest } from "../client.js";
import { ENDPOINTS } from "../endpoints.js";

export async function acknowledgeOrderSheets({
  vendorId,
  shipmentBoxIds = [],
  accessKey,
  secretKey,
}) {
  const path = ENDPOINTS.ACKNOWLEDGE_ORDER_SHEETS.replace(
    "{vendorId}",
    encodeURIComponent(String(vendorId || "")),
  );

  return coupangRequest({
    method: "PUT",
    path,
    body: {
      vendorId: String(vendorId || "").trim(),
      shipmentBoxIds: (Array.isArray(shipmentBoxIds) ? shipmentBoxIds : [])
        .map((x) => String(x ?? "").trim())
        .filter(Boolean),
    },
    accessKey,
    secretKey,
  });
}
