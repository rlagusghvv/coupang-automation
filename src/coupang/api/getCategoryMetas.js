import { coupangRequest } from "../client.js";

export async function getCategoryMetas({ displayCategoryCode }) {
  if (!displayCategoryCode) throw new Error("displayCategoryCode required");
  return coupangRequest({
    method: "GET",
    path: `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${displayCategoryCode}`,
  });
}
