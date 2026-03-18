import { coupangRequest } from "../client.js";
import { ENDPOINTS } from "../endpoints.js";

function normalizeInvoiceDto(raw = {}) {
  return {
    shipmentBoxId: String(raw.shipmentBoxId ?? "").trim(),
    orderId: String(raw.orderId ?? "").trim(),
    vendorItemId: String(raw.vendorItemId ?? "").trim(),
    deliveryCompanyCode: String(raw.deliveryCompanyCode ?? "").trim(),
    invoiceNumber: String(raw.invoiceNumber ?? "").trim(),
    splitShipping: raw.splitShipping === true,
    preSplitShipped: raw.preSplitShipped === true,
    estimatedShippingDate: String(raw.estimatedShippingDate ?? "").trim(),
  };
}

export async function uploadOrderInvoices({
  vendorId,
  items = [],
  accessKey,
  secretKey,
}) {
  const path = ENDPOINTS.UPLOAD_ORDER_INVOICES.replace(
    "{vendorId}",
    encodeURIComponent(String(vendorId || "")),
  );

  return coupangRequest({
    method: "POST",
    path,
    body: {
      vendorId: String(vendorId || "").trim(),
      orderSheetInvoiceApplyDtos: (Array.isArray(items) ? items : []).map(normalizeInvoiceDto),
    },
    accessKey,
    secretKey,
  });
}
