# CLI Handoff (2026-02-26)

## Scope
- Repo: `coupang-automation`
- Branch: `hotfix/go-live-docs-20260214`
- Current HEAD at handoff: `6f12fe9`

## What was fixed in this session
1. **Domeggook 상세 이미지 오염 제거 (핵심)**
- Root cause: `contentsBuffer` HTML 파싱 시 하단 `상품공급사 추천상품`(01~30 그리드) 영역 이미지가 상세로 혼입됨.
- Added new sanitizer utility:
  - `src/utils/domeggookDetailHtml.js`
- Applied sanitizer in both parsing paths:
  - `src/sources/domaeqq/parseProductFromDomaeqq.js`
  - `src/server/recommendations.js` (HTML fallback path)
- Sanitizer rules:
  - Remove catalog block: `<!-- [ST]catalog --> ... <!-- [ED]catalog -->`
  - Remove promo containers by id/class (`recommend`, `related`, `aitemsRecommend`, etc.)
  - Cut from promo text markers (`상품공급사 추천상품`, `함께 사면 더 좋은 상품`, `꾹AI:추천`)
  - Fallback cut for `data-focus="#nav_*_idx"` thumbnail grid pattern

2. **Earlier related fixes already on same branch (important context)**
- `03c7004`: 추천 카드 `상세 N장` 표시값/이유 문자열/computed count 정합성 보정
- `7121e43`: ownerclan copy 상세 경로 복구 및 신뢰 경로 확장

## Verification snapshots
- Test URL: `https://domeggook.com/42551823`
- Before fix: detail raw image count included promo thumbnails (`48`)
- After fix: promo removed (`18`) and tail images are actual detail assets (`gi.esmplus.com/...`)
- Regression sanity:
  - `https://domeggook.com/63272777` stays valid (`raw=2, filtered=2`)

## Commits
- `6f12fe9` fix: strip domeggook promo grid from detail image parsing
- `03c7004` recommendations: normalize detail image counts for UI
- `7121e43` preview: support ownerclan copy detail images

## Mac mini apply commands
```bash
cd /Users/kimhyunhomacmini/.openclaw/workspace/coupang-automation
git fetch --all
git checkout hotfix/go-live-docs-20260214
git pull --ff-only
launchctl kickstart -k gui/$(id -u)/com.splui.coupelephant-server
```

## Next CLI prompt (copy/paste)
```text
너는 couplus-clone 유지보수 엔지니어다.
목표: 추천 카드 상세이미지에 하단 추천상품(상품공급사 추천상품) 혼입이 재발하지 않는지 운영 환경에서 검증하고, 남은 이슈(내 상품 sync 시 deployed 전이) 원인까지 좁힌다.

환경:
- 레포: /Users/kimhyunhomacmini/.openclaw/workspace/coupang-automation
- 브랜치: hotfix/go-live-docs-20260214
- 기준 커밋: 6f12fe9

필수 작업:
1) 코드/서버 반영
- git fetch --all
- git checkout hotfix/go-live-docs-20260214
- git pull --ff-only
- launchctl kickstart -k gui/$(id -u)/com.splui.coupelephant-server

2) 상세이미지 혼입 검증 (최소 3 URL)
- 반드시 https://domeggook.com/42551823 포함
- previewUploadFromUrl로 각 URL의 raw/filtered count, tail URL 5개 출력
- 판정 기준: tail 에 domeggook.com/<6자리> 추천썸네일 그리드 계열이 없어야 함

3) 추천 채우기 실검증
- /api/recommendations/fill 1회 실행
- 응답의 fill.count, diagnostics.validated, qcRejected, qcReasonCounts 출력
- 추천 카드에서 상세 N장과 실제 preview.contentImagesFiltered 길이 일치 확인

4) 내 상품 sync -> deployed 문제 원인 수집
- sync 전/후 status 전이 로그 수집
- 어떤 코드 경로에서 status를 deployed로 세팅하는지 파일/함수/라인 제시
- 즉시 완화안 1개 + 근본 수정안 1개 제시

출력 형식:
- ✅/❌ 단계별 결과
- 사용 커밋 해시
- 검증 URL별 raw/filtered 요약 표
- deployed 전이 원인(코드 참조)
- 바로 적용 가능한 다음 명령 1~2개
```

## Note
- Worktree has unrelated local changes in Flutter generated files. Do not include them in backend hotfix commits unless explicitly requested.
