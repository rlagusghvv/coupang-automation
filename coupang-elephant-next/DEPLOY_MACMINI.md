# Coupang Elephant Next Frontend (Mac mini 배포)

이 프론트는 `/api`, `/console`, `/couplus-out`, `/tmp` 요청을
외부 백엔드 오리진으로 프록시합니다.

## 1) 환경변수

`.env` 또는 실행 환경에 아래 값을 넣습니다.

```bash
COUPANG_ELEPHANT_BACKEND_ORIGIN=https://app2.splui.com
```

## 2) 배포

```bash
cd /Users/kimhyunhomacmini/.openclaw/workspace/coupang-automation/coupang-elephant-next
npm install
npm run build
```

## 3) 실행(프론트만)

```bash
npm run start -- --hostname 0.0.0.0 --port 3333
```

운영에서는 launchd/pm2로 위 실행 커맨드를 등록해 상시 실행합니다.
로컬 백엔드(`127.0.0.1:3000`)를 새로 띄울 필요는 없습니다.
