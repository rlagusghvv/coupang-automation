export function buildAttributes({ size = "FREE", qty = "1개" } = {}) {
  return [
    { attributeTypeName: "사이즈", attributeValueName: size },
    { attributeTypeName: "수량", attributeValueName: qty },
  ];
}
