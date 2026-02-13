# Ops Runbook (Coupang 코끼리)

## Components
- Legacy server (Express): launchd `com.splui.coupelephant-server` (port 3000)
- Cloudflare Tunnel: launchd `com.splui.coupelephant-cloudflared`
- (Optional) Next UI: launchd `com.splui.coupelephant-next` (port 3333) — currently disabled for Flutter-only /app

## Common issues
### 1) app.splui.com 502
- Check local origin:
  - curl -I http://127.0.0.1:3000/app/
- Check cloudflared processes (avoid duplicates):
  - ps aux | grep cloudflared
- Restart cloudflared launchagent:
  - launchctl kickstart -kp gui/$(id -u)/com.splui.coupelephant-cloudflared

### 2) /auth/kakao 500
- Usually missing env:
  - KAKAO_REST_KEY
  - KAKAO_REDIRECT_URI
- After env apply, restart server:
  - launchctl kickstart -kp gui/$(id -u)/com.splui.coupelephant-server

### 3) Web = App (Flutter) routing
- Ensure cloudflared ingress routes `app.splui.com` to `http://127.0.0.1:3000`
- Local check:
  - curl -I http://127.0.0.1:3000/app/

## Health URLs
- External:
  - https://app.splui.com/app/
- Local:
  - http://127.0.0.1:3000/app/
  - http://127.0.0.1:3000/health

