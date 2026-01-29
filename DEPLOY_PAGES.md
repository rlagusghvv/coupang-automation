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

```
npm install
npm run start
```

업로드 엔드포인트는:
```
POST /api/upload
{ "url": "https://domeggook.com/..." }
```

## 3) Pages에서 테스트

브라우저:
```
https://<your-pages-domain>/
```

도매꾹 링크 입력 → 업로드 → 결과 확인
