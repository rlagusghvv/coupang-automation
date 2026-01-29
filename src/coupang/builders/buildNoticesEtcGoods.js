export function buildNoticesEtcGoods({
  modelName = "상세페이지 참조",
  certification = "상세페이지 참조",
  origin = "대한민국",
  manufacturer = "상세페이지 참조",
  contact = "010-0000-0000",
} = {}) {
  const noticeCategoryName = "기타 재화";
  return [
    { noticeCategoryName, noticeCategoryDetailName: "품명 및 모델명", content: modelName },
    { noticeCategoryName, noticeCategoryDetailName: "인증/허가 사항", content: certification },
    { noticeCategoryName, noticeCategoryDetailName: "제조국(원산지)", content: origin },
    { noticeCategoryName, noticeCategoryDetailName: "제조자(수입자)", content: manufacturer },
    { noticeCategoryName, noticeCategoryDetailName: "소비자상담 관련 전화번호", content: contact },
  ];
}
