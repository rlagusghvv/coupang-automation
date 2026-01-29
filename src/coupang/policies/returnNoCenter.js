export function returnNoCenter({
  returnChargeName = "반품담당자",
  companyContactNumber = "010-0000-0000",
  returnZipCode = "12345",
  returnAddress = "서울특별시 강남구 테헤란로 1",
  returnAddressDetail = "101호",
  returnCharge = 2500,
} = {}) {
  return {
    returnCenterCode: "NO_RETURN_CENTERCODE",
    returnChargeName,
    companyContactNumber,
    returnZipCode,
    returnAddress,
    returnAddressDetail,
    returnCharge,
    deliveryChargeOnReturn: returnCharge,
    returnChargeOnFree: returnCharge,
  };
}
