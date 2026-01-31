# Pages 배포 메모 (요약)

이 프로젝트는 **프론트는 Pages**, **업로드 실행은 별도 Node 서버**로 분리되어야 합니다.
Pages/Workers 런타임에서는 Playwright 실행이 불가합니다.

## 1) Pages (프론트 + API 프록시)

- Pages 프로젝트 생성 후 Git 연결
- Functions 경로: `functions/api/upload.js`
- 환경변수 추가:
  - `UPLOADER_URL` = 업로드 실행 서버의 엔드포인트
    - 예: `https://your-node-server.com/api/upload`

## 2) Node 업로드 실행기 (별도 서버)

Express 서버를 그대로 사용:

```bash
npm install
npm run start
```

### ✅ 서버는 쿠팡 키 없이도 실행됩니다
- 먼저 UI/로그인/세션 생성/Preview 기능부터 확인 가능
- Execute(실제 쿠팡 업로드)는 설정에 쿠팡 키가 있어야 동작

### 엔드포인트
- Preview (쿠팡 키 불필요)
```http
POST /api/upload/preview
{ "url": "https://domeggook.com/..." }
```

- Execute (쿠팡 키 필요)
```http
POST /api/upload/execute
{ "url": "https://domeggook.com/..." }
```

- Legacy
```http
POST /api/upload
{ "url": "https://domeggook.com/..." }
```

### 세션 파일 저장 위치
- 기본: `~/.couplus/`
  - 도매꾹: `storageState.domeggook.json`
  - 도매매: `storageState.domeme.json`

## 3) Pages에서 테스트

브라우저:
```
https://<your-pages-domain>/
```

도매꾹 링크 입력 → 업로드 → 결과 확인
