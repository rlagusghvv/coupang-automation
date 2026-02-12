# Current Progress (Coupang Elephants / coupang-automation)

## 2026-02-12

### What’s broken right now (observed)
1) **Dashboard bot LaunchAgent** was failing every 120s with exit 127 because script path was missing:
   - `com.splui.coupelephant-dashboard-bot` ran `./ops/dashboard_update.sh` but `ops/` did not exist.
   - Result: noisy logs + no dashboard updates.

2) **Server port 3000 already in use** errors appear when a second instance is started:
   - Running instance: LaunchAgent `com.splui.coupelephant-server` listens on `0.0.0.0:3000`.
   - If someone runs `node server.js` manually while launchd job is alive, it crashes with `EADDRINUSE`.

3) **Recommendation/upload failures** (from `/api/status/summary`):
   - `coupang_create_failed`
   - `main_image_download_failed`
   - `coupang_rate_limited`
   - `image_host_unreachable`

### Fix applied (ops/dashboard)
- Added `ops/dashboard_update.sh` to match the dashboard LaunchAgent expectation.
  - Script calls `GET http://127.0.0.1:3000/api/status/summary` with `STATUS_API_TOKEN`
  - Then edits/sends a Telegram message using env vars in the LaunchAgent.

### Fix applied (reliability)
- Increased Domeggook HTML parse timeout from **12s → 25s** in:
  - `src/pipeline/previewUploadFromUrl.js`
  - `src/pipeline/runUploadFromUrl.js`
  Reason: when parsing times out, draft.price becomes null → later upload/recommendation steps can fail.

---

## Upload failure fixes (implemented)

### Symptoms
1) `main_image_download_failed`
   - Root cause: image URL can be a “wrapper” URL (nested/URL-encoded original URL in query params) or returns non-image responses (HTML/login/blocked) depending on UA/referer/redirect.

2) `coupang_create_failed` with message:
   - `[옵션(단품) : 10원 이상의 판매가를 입력해주세요.]`
   - Root cause: option item price could become `NaN` (non-finite). `Math.max(min, NaN) -> NaN`, which then went into `salePrice/originalPrice`.

### Fixes
1) **Image URL normalization + candidate expansion**
- Added `src/utils/imageUrlNormalize.js`
  - `normalizeDomeggookThumbOriginalUrl()` extracts nested image URLs from common params (`thumbOriginal`, `url`, `src`, ...)
  - `expandCandidateImageUrls()` generates variants (https-upgrade, queryless URL)

2) **More robust Playwright image download**
- Updated `src/utils/playwrightImageDownload.js`
  - Uses realistic Chrome UA + accept headers
  - Sends `referer` + `user-agent`, allows redirects
  - Skips non-`image/*` content-types (prevents saving HTML)
  - Tries expanded/normalized candidate URLs

3) **Guaranteed finite option item prices (>= 1000)**
- Updated `src/utils/price.js`
  - Added `sanitizeCoupangPrice()`
  - `computePrice()` now always returns a finite integer (fallback to min when base invalid)
- Updated `src/coupang/builders/buildSingleItem.js`
  - Sanitizes `salePrice/originalPrice`
- Updated `src/pipeline/runUploadFromUrl.js`
  - Option item price now sanitized before payload

### Tests
- Enabled Node test runner: `npm test` → `node --test`
- Added:
  - `test/price.test.js`
  - `test/imageUrlNormalize.test.js`

---

### Product direction (UX reference)
- Reference SaaS to match closely for v1: https://www.coupilot.net/
- Goal: produce a "유사/동일" 1st complete version (flow + UI/UX) before additional iterations.

### Commands / quick checks
- Server health:
  - `curl -H "Authorization: Bearer $STATUS_API_TOKEN" http://127.0.0.1:3000/api/status/summary`
- LaunchAgents:
  - `launchctl list | grep coupelephant`
