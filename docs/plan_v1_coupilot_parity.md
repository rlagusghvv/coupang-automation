# Plan v1 (Coupilot.net parity) — Coupang Elephants

Reference: https://www.coupilot.net/
Goal: “유사/동일” 수준의 1차 완성본을 빠르게 만들고, 이후 차별화(우리만의 강점)로 확장.

## North-star user flow (must feel seamless)
1) 로그인/온보딩
2) 소스 URL/상품 선택 → Preview
3) 필수 설정(카테고리/가격/배송/옵션/이미지)
4) 업로드 큐에 넣기(대량 처리)
5) 진행상태/실패원인/재시도/재처리
6) 업로드 성공 후 결과(상품ID/링크) + 히스토리

## Milestones

### M0 — Reliability ("업로드가 된다"가 먼저)
- Upload failures 0→success baseline
  - main image download 안정화
  - 옵션 단품 가격 NaN 방지
  - rate limit backoff + retry policy
- Status dashboard (요약/알람) 안정화

### M1 — Coupilot-like UX (핵심 화면 구성)
- Landing/Console 정보 구조 정리
  - 좌측/상단 네비
  - “URL 넣기 → Preview → Queue” 3단 동선
- Preview 화면 강화
  - 대표이미지/상세이미지 리스트
  - 가격정책(마진/배송비) 미리보기
  - 카테고리 추천/오버라이드
  - 옵션 테이블 편집(단가/재고/활성화)

### M2 — Bulk / Queue as product (대량 업로드가 제품)
- 큐: enqueue / cancel / retry / backoff / concurrency=1
- 실패 이유를 “사람이 바로 고칠 수 있게” (필드별 가이드)
- Presets
  - 가격정책/배송정책/카테고리/이미지 정책
  - 키워드 기반 추천상품 자동 채우기

### M3 — Differentiation (우리만의 마스터피스)
- 자동화: 상품 소싱(키워드/카테고리) → 검증 → 큐 투입
- 품질: 제목/키워드/썸네일 개선
- 운영: 승인/반려/정책 위반 사전 필터

## Workstreams (병렬)
- Backend: upload pipeline, retry/backoff, robust parsing, better error detail
- Frontend: console UX, preview editor, queue dashboard
- Data/Rules: category mapping, banned keywords, pricing heuristics
- Ops: launchd stability, dashboard bot, monitoring

## Acceptance checklist for v1
- 10개 URL 연속 업로드 성공률 80%+ (실패는 명확한 이유/가이드 제공)
- 실패한 건 1-2번 클릭으로 재시도 가능
- Preset 저장/불러오기 가능
- 업로드 히스토리/결과 링크 제공

