# Instagram Reels Automation (Tracking + Prompt Pack)

## What Was Added
- Marketing tracking links with click logging
  - `POST /api/marketing/links`
  - `GET /api/marketing/links`
  - `GET /api/marketing/links/:slug/clicks`
  - public redirect: `GET /go/m/:slug`
- Reels prompt pack generator API
  - `POST /api/marketing/reels/pack`
- CLI helper
  - `scripts/generate_instagram_reels_pack.mjs`

## Reels Pack API
Request:

```json
{
  "platform": "instagram",
  "campaign": "pet_walk_2026w10",
  "brand": "쿠팡코끼리",
  "tone": "실용적",
  "autoCreateLinks": true,
  "items": [
    {
      "title": "반려동물 산책 리드줄 정리 파우치",
      "keyword": "반려동물 산책",
      "targetUrl": "https://www.coupang.com/vp/products/1234567890",
      "sourceUrl": "https://domeggook.com/12345"
    }
  ]
}
```

Response includes:
- `tracking.slug`, `tracking.trackingUrl`
- `pack.hooks`, `pack.storyboards`, `pack.captions`, `pack.hashtags`
- `pack.grokVideoPrompts` (copy to Grok video workflow)

## CLI Usage

```bash
node scripts/generate_instagram_reels_pack.mjs \
  --base http://127.0.0.1:3000 \
  --session "<SESSION_TOKEN>" \
  --items out/reels_items.json \
  --campaign pet_walk_2026w10 \
  --brand "쿠팡코끼리" \
  --tone "실용적" \
  --auto-links 1
```

Output:
- `out/instagram_reels_pack_*.json`

## Recommended Video Tooling
- Grok: script/scene idea generation, hook variants, caption rewrites
- Video renderer: CapCut/Kling/Runway (template-based 9:16)
- Final post: Instagram Reels with the generated tracking URL (`/go/m/:slug`)

## Operational Rule
- Create 2~3 variants per product
- Track by `campaign + content`
- After 72h, keep winners (high clicks) and replace low performers
