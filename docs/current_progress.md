# Current Progress (Coupang Elephants / coupang-automation)

## 2026-02-12

### What’s broken right now (observed)
1) **Dashboard bot LaunchAgent** was failing every 120s with exit 127 because script path was missing:
   - `com.splui.coupelephant-dashboard-bot` ran `./ops/dashboard_update.sh` but `ops/` did not exist.
   - Result: noisy logs + no dashboard updates.

2) **Server port 3000 already in use** errors appear when a second instance is started:
   - Running instance: LaunchAgent `com.splui.coupelephant-server` (pid 21820) listens on `0.0.0.0:3000`.
   - If someone runs `node server.js` manually while launchd job is alive, it crashes with `EADDRINUSE`.

3) **Recommendation/upload failures** (from `/api/status/summary`):
   - `coupang_create_failed` (4)
   - `main_image_download_failed` (3)
   - `coupang_rate_limited` (1)
   - `image_host_unreachable` (1)
   - Last failed: `2026-02-11T06:56:02.022Z`
   - No successful uploads recorded in recent 200 jobs.

### Fix applied (today)
- Added `ops/dashboard_update.sh` to repo workspace to match launchd job expectation.
  - Script calls `GET http://127.0.0.1:3000/api/status/summary` with `STATUS_API_TOKEN`
  - Then edits/sends a Telegram message using env vars in the LaunchAgent.
- Truncated old `data/dashboard_bot.err.log` after validation to remove stale noise.

### Next steps (to find root cause of “추천 상품 업로드 안됨”)
1) Inspect recent failed jobs in sqlite:
   - `data/app.db` tables: `jobs`, `uploaded_products` (confirm which error codes correlate with which URLs)
2) For `main_image_download_failed` / `image_host_unreachable`:
   - confirm image host blocks hotlinking / requires headers; add retry + fallback download.
3) For `coupang_rate_limited`:
   - implement exponential backoff + concurrency=1 + per-endpoint limiter.
4) For `coupang_create_failed`:
   - log Coupang API response body/code; likely auth/required fields/certification/category mismatch.

### Fix applied (reliability)
- Increased Domeggook HTML parse timeout from **12s → 25s** in:
  - `src/pipeline/previewUploadFromUrl.js`
  - `src/pipeline/runUploadFromUrl.js`
  Reason: when parsing times out, draft.price becomes null → later upload/recommendation steps can fail.

### Product direction (UX reference)
- Reference SaaS to match closely for v1: https://www.coupilot.net/
- Goal: produce a "유사/동일" 1st complete version (flow + UI/UX) before additional iterations.

### Commands / quick checks
- Server health:
  - `curl -H "Authorization: Bearer $STATUS_API_TOKEN" http://127.0.0.1:3000/api/status/summary`
- LaunchAgents:
  - `launchctl list | grep coupelephant`

