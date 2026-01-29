import { coupangRequest } from "../client.js";

export async function recommendCategory({
  productName,
  productDescription = "",
  productImageUrl = "",
  productBrand = "",
  productManufacturer = "",
  accessKey,
  secretKey,
} = {}) {
  if (!productName) throw new Error("productName required");

  return coupangRequest({
    method: "POST",
    path: "/v2/providers/openapi/apis/api/v1/categorization/predict",
    body: {
      productName,
      productDescription,
      productImageUrl,
      productBrand,
      productManufacturer,
    },
    accessKey,
    secretKey,
  });
}
