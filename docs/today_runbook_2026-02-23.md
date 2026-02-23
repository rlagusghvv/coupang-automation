# Today Runbook (빠른 검증용)

## 1) 코드 동기화
```bash
git checkout hotfix/go-live-docs-20260214
git pull --rebase origin hotfix/go-live-docs-20260214
```

## 2) 핵심 회귀 테스트
```bash
node scripts/qc_gate_regression.mjs
```
- 기대: `ok=true`, `createCalls=0`

## 3) Preview-only 품질 판정 (실URL)
```bash
node scripts/qc_gate_smoke.mjs --urls "https://domeggook.com/59970154,https://domeggook.com/6671177,https://domeggook.com/6715571" --preview-only
```
- 기대: env 에러(vendorId required) 없음

## 4) 실업로드 1건 검증
```bash
# 앱/세션 기준 실제 실행 또는 runUploadFromUrl 테스트
```
- 결과 확인 키:
  - `create.sellerProductId`
  - `followUp.statusName`
  - `qc.ok`

## 5) 운영 보고 포맷
- 🟢 올림: <URL> / sellerProductId:<id>
- 🔴 스킵: <URL> / reason:<1줄>

## 6) 오늘 종료 조건
- 정상 1개 업로드 성공
- 문제 2개 자동 차단
- 회귀 테스트 PASS
