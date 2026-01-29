export function buildItemImages({ url } = {}) {
  if (!url) throw new Error("buildItemImages: url required");
  return [
    {
      imageOrder: 0,
      imageType: "REPRESENTATION",
      vendorPath: url,
    },
  ];
}
