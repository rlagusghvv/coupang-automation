export function buildAttributes({ qty = "1" } = {}) {
  // Minimal safe defaults. Category-specific required attributes should be filled from metadata.
  return [
    { attributeTypeName: "수량", attributeValueName: String(qty) },
  ];
}
