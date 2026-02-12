# Status Updates (Internal) — coupang-automation

> 텔레그램 중복을 줄이기 위해, 진행상황/원인/다음 액션은 이 파일에만 기록.

## 2026-02-12

### 17:31 KST — data (일정 제안: 오늘 '돌아가게' + 1주 안정화)
- 오늘 목표(내일 테스터 투입 전): "끊기지 않고 돌아가게" 기준으로 MVP 안정화
  1) 추천 채우기(fill) 1회 실행이 끝까지 성공(진행률 표시 + 실패 시 재시도 가이드)
  2) 업로드 1건 이상 end-to-end 성공(히스토리/로그 남김)
  3) 서버 재시작/중복 실행로 인한 다운 방지(EADDRINUSE 해결: 단일 프로세스 관리)
- 48시간 목표(지인 테스트 전): 오류 메시지/복구 UX, 429 방어(백오프/레이트리밋) 관측 강화
- 7일 목표(유료 수준 초석): 장애 재현/알림/자동복구 + 핵심 플로우 테스트 커버리지 추가


### 17:27 KST — data (제품 원칙 정리)
- 대표 요구사항(제품/전략): 유료 서비스 가능한 안정성 수준, 타겟=소규모 셀러, 현 단계 과금/비용 최소
- 문서화: `docs/product_principles.md`

### 17:12 KST — data (기능: 추천 진행상황 API)
- 추가: `GET /api/recommendations/status` (authRequired)
  - activeJob(recommendations_fill|recommendations) + progress(job.resultJson.progress) + cache count 반환
- 목적: 모바일/웹 UI에서 "추천 채우기" 진행률/멈춤 여부를 안정적으로 표시
- 변경: `server.js`, `src/server/recommendations.js`

### 17:00 KST — data (레퍼런스 분석: coupilot.net)
- 대표 요청: <https://www.coupilot.net/> 과 **완전히 유사**한 1차 완성본 목표
- 조치: 랜딩/정보구조/섹션 구성/CTA를 우리 서비스로 매핑한 메모 추가
  - `docs/competitor_coupilot_notes.md`
- 다음: 랜딩 페이지 카피/섹션/대시보드 UX를 이 문서 기준으로 재구성(디자인 시스템 포함)


### 16:15 KST — data (현 상태 파악 / 추천상품 업로드 이슈 1차)
- 서버 상태: `http://127.0.0.1:3000/health` = OK (node server.js 구동 중)
- 관측: 과거 로그에 `EADDRINUSE: 0.0.0.0:3000` 가 있음 → 재시작/중복 실행 시 포트 충돌로 서버가 죽을 수 있음
- 추천(recommendations) API는 authRequired라서(쿠키/세션 필요) 외부에서 단순 curl로는 즉시 재현/확인 불가
- 다음 액션(확정 필요):
  1) 서버 프로세스 단일화 + 재시작 안정화(launchd/pm2/docker 중 택1)로 EADDRINUSE 재발 방지
  2) 추천상품 “업로드/생성” 실패 케이스를 재현하려면: 실제 UI 로그인 세션 또는 서버 로그(최근 추천 job 실행 로그) 확보 필요
  3) 최근 429/대기/0개 생성 이슈는 `docs/recommendations-worklog.md`의 429 대응 설계(캐시 fill) 기준으로 점검
