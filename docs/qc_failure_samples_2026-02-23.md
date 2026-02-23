# QC Failure Sample Set (2026-02-23)

목적: QC Gate 튜닝 시 재현 가능한 실패 샘플을 고정해서 회귀 확인.

## A. 오염/잡이미지 혼입 리스크 URL
- https://domeggook.com/59970154
  - 이슈: 상세 HTML에 `image/common/sns`, `image/item/view` 같은 UI/SNS 자산 혼입
  - 기대: 비상품 자산 차단 후에도 유효 상세 이미지 부족이면 `qc_gate_failed`

## B. 자동차 카테고리(필수속성) 리스크 URL
- https://domeggook.com/6671177
  - 이슈: 카테고리 78838에서 필수속성(예: 모델명/품번, RAM/메모리) 누락 시 임시저장/실패
  - 기대: 필수속성 자동 보정 + 제목 정제 적용 후 정상 생성

- https://domeggook.com/6715571
  - 이슈: 6671177과 유사 패턴(카테고리/속성/상세 자산 신뢰도 이슈)
  - 기대: 품질 기준 미달 시 차단, 충족 시만 생성

## C. 테스트 분류 기준
- 정상(통과 예상): 1개
- 오염(차단 예상): 1개
- 저품질(차단 예상): 1개

## D. PASS 기준
- 정상 URL: create.sellerProductId 발급 + 상세 품질 확인
- 차단 URL: `error=qc_gate_failed` + `detail.reasons` 명확
- 회귀: `qc_gate_failed`일 때 create 호출 0
