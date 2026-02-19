export function buildAttributes({ size = "FREE", qty = "1개", qtyPerUnit = "1" } = {}) {
  // Some Coupang categories require specific attribute names (e.g. "개당 수량").
  // Provide a safe default so product creation won't get stuck in "임시저장".
  return [
    { attributeTypeName: "사이즈", attributeValueName: size },
    { attributeTypeName: "수량", attributeValueName: qty },
    { attributeTypeName: "개당 수량", attributeValueName: qtyPerUnit },
  ];
}
