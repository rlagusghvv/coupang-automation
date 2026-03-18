export const ENDPOINTS = {
  CREATE_SELLER_PRODUCT:
    "/v2/providers/seller_api/apis/api/v1/marketplace/seller-products",
  GET_SELLER_PRODUCT:
    "/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/{sellerProductId}",
  GET_SELLER_PRODUCT_HISTORIES:
    "/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/{sellerProductId}/histories",
  GET_ORDER_SHEETS:
    "/v2/providers/openapi/apis/api/v5/vendors/{vendorId}/ordersheets",
  GET_ORDER_SHEET_BY_SHIPMENT_BOX:
    "/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/ordersheets/{shipmentBoxId}",
  ACKNOWLEDGE_ORDER_SHEETS:
    "/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/ordersheets/acknowledgement",
  UPLOAD_ORDER_INVOICES:
    "/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/orders/invoices",
};
