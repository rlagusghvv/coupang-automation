import { toCoupangImageUrl } from "../utils/coupangImageUrl.js";

export function buildTopImages({ url }) {
  const finalUrl = toCoupangImageUrl(url);
  return [
    { imageOrder: 0, imageType: "REPRESENTATION", imageLocation: finalUrl },
  ];
}
