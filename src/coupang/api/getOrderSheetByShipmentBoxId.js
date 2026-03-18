import { coupangRequest } from "../client.js";
import { ENDPOINTS } from "../endpoints.js";

export async function getOrderSheetByShipmentBoxId({
  vendorId,
  shipmentBoxId,
  accessKey,
  secretKey,
}) {
  const path = ENDPOINTS.GET_ORDER_SHEET_BY_SHIPMENT_BOX
    .replace("{vendorId}", encodeURIComponent(String(vendorId || "")))
    .replace("{shipmentBoxId}", encodeURIComponent(String(shipmentBoxId || "")));

  return coupangRequest({
    method: "GET",
    path,
    accessKey,
    secretKey,
  });
}
