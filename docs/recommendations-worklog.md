# Recommendations caching refactor (2026-02-10)

## Problem
- The original recommendations flow tried to generate a full list in one shot (collect → validate → replace).
- Domeggook frequently returns **HTTP 429 (Too Many Requests)**, causing the “collect candidates” stage to stall at 0.
- UX was confusing: UI showed only “loading…” without progress/phase visibility.

## Changes (high level)
### 1) Add progress reporting (job.result_json.progress)
- Server periodically updates `jobs.result_json.progress` while running recommendation jobs.
- App polls job status and displays a lightweight progress string.

### 2) Fix candidate URL extraction from Domeggook list pages
- Domeggook list pages often include product links as relative paths like:
  - `/63410895?advcnt=...`
- Extractor updated to recognize relative numeric IDs and paginate across `page=2..N`.

### 3) New cache-first architecture (fill instead of regenerate)
- Introduced **append/upsert** flow that fills the cache gradually instead of replacing.
- New endpoint/job kind:
  - `POST /api/recommendations/fill` → creates job `recommendations_fill`
- The fill job:
  - reads existing recommendations for the user
  - picks the next keyword (round-robin cursor)
  - generates a small batch
  - `INSERT OR IGNORE` into `recommendations` (unique on `(user_id, source_url)`)
  - prunes to a max size

Why: reduces request bursts and makes the system resilient to 429.

## DB
- Added table `recommendations_state`:
  - `user_id` (PK)
  - `next_keyword_idx` (round-robin cursor)
  - `updated_at`

## Files changed
- `src/server/recommendations.js`
  - added `upsertRecommendationsForUser`
  - added `fillRecommendationsForUser`
  - added internal batch generator + state helpers
- `src/server/storage_sqlite.js`
  - creates `recommendations_state` table
- `server.js`
  - added `POST /api/recommendations/fill`
  - keep legacy `POST /api/recommendations/run` for debugging
- `couplus_mobile/lib/screens/recommendations_screen.dart`
  - call `/api/recommendations/fill` instead of `/api/recommendations/run`

## Notes / Next steps
- If 429 persists, further improvements:
  - add global per-host request limiter
  - reduce keyword count per run
  - schedule periodic fill (cron) and keep UI purely cache-driven
  - show dedicated progress widget instead of reusing the error banner
