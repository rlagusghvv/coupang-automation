# Status Updates (Internal) — coupang-automation

> 텔레그램 중복을 줄이기 위해, 진행상황/원인/다음 액션은 이 파일에만 기록.

## 2026-02-12

### 16:15 KST — data (현 상태 파악 / 추천상품 업로드 이슈 1차)
- 서버 상태: `http://127.0.0.1:3000/health` = OK (node server.js 구동 중)
- 관측: 과거 로그에 `EADDRINUSE: 0.0.0.0:3000` 가 있음 → 재시작/중복 실행 시 포트 충돌로 서버가 죽을 수 있음
- 추천(recommendations) API는 authRequired라서(쿠키/세션 필요) 외부에서 단순 curl로는 즉시 재현/확인 불가
- 다음 액션(확정 필요):
  1) 서버 프로세스 단일화 + 재시작 안정화(launchd/pm2/docker 중 택1)로 EADDRINUSE 재발 방지
  2) 추천상품 “업로드/생성” 실패 케이스를 재현하려면: 실제 UI 로그인 세션 또는 서버 로그(최근 추천 job 실행 로그) 확보 필요
  3) 최근 429/대기/0개 생성 이슈는 `docs/recommendations-worklog.md`의 429 대응 설계(캐시 fill) 기준으로 점검
