# Current Progress (Coupang Elephants / coupang-automation)

## 2026-02-12

### Latest progress (18:52 KST)
- Recent commits on branch include fixes for:
  - Recommendations bulk enqueue stability (prevent missing queue items under burst clicks)
  - Image download normalization (avoid HTML/404 hotlink cases)
  - Option price sanitization (prevent Coupang validation errors due to NaN)
- Server status summary still shows historical failures; next verification step is to run a fresh recommendations multi-select enqueue + execute and confirm the new fixes eliminate: `SQLITE_BUSY`, `main_image_download_failed`, and `coupang_create_failed`.

### User direction (17:33 KST)
- Manual URL upload flow is already working; **do not churn working upload code**.
- The reported "upload errors" are mainly in the **Recommendations** flow.
  - Specifically: happens when **uploading multiple recommended items at once** (bulk from recommendations list).
- Focus efforts on: (1) recommendation quality (competitive products) (2) UX details like Coupilot.net, while keeping stable parts unchanged.

### What’s broken right now (observed)
1) **Recommendations bulk upload enqueue can fail intermittently**
   - Failure mode: when selecting many recommended items and tapping bulk upload, the app fires many `/api/upload-queue/enqueue` requests concurrently.
   - Observed error (server-side): `SQLITE_BUSY: database is locked` from sqlite writes.
   - Effect: some items never get enqueued (missing from upload queue), or enqueue returns 500.

2) **Dashboard bot LaunchAgent** was failing every 120s with exit 127 because script path was missing:
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
- **SQLite busy timeout + WAL** to make bulk enqueue reliable
  - Updated `openDb()` in:
    - `src/server/storage_sqlite.js`
    - `src/server/storage_sqlite_internal.js`
  - Added:
    - `db.configure('busyTimeout', 5000)`
    - `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`
  - Root cause: many concurrent enqueue requests cause sqlite writer contention; without busyTimeout sqlite throws `SQLITE_BUSY` immediately.

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
  - `test/sqliteConcurrency.test.js` (guards against `SQLITE_BUSY` during bulk enqueue)

---

### Product direction (UX reference)
- Reference SaaS to match closely for v1: https://www.coupilot.net/
- Goal: produce a "유사/동일" 1st complete version (flow + UI/UX) before additional iterations.

### Ops note (service restart)
- `com.splui.coupelephant-server` restart can hit `EADDRINUSE` if an old node process is still bound to 3000.
- Clean restart sequence (macOS launchd):
  - `launchctl kill SIGTERM gui/$(id -u)/com.splui.coupelephant-server`
  - `launchctl kickstart -k gui/$(id -u)/com.splui.coupelephant-server`

### Commands / quick checks
- Server health:
  - `curl -H "Authorization: Bearer $STATUS_API_TOKEN" http://127.0.0.1:3000/api/status/summary`
- Port check:
  - `/usr/sbin/netstat -anv | grep '\.3000' | grep LISTEN`
- LaunchAgents:
  - `launchctl list | grep coupelephant`
