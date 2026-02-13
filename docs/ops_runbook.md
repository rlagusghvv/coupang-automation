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

### 2) 로그인/인증 문제(401 unauthorized)
- 이 서비스는 `session` 쿠키 기반 인증을 사용함.
- 먼저 `/api/signup` 또는 `/api/login`으로 세션 쿠키가 발급되는지 확인.
- 브라우저에서 쿠키 차단/다른 도메인(서브도메인) 혼용 시 401이 날 수 있음.
- 서버 재기동:
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

