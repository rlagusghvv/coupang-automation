# Architecture Notes / 설계 원칙

이 문서는 Couplus(쿠플러스) 시스템을 **사업화/수익화 가능한 확장형 SaaS**로 만들기 위한 기본 아키텍처 원칙을 기록한다.

> 원칙은 “이상”이 아니라, 개발/운영에서 매번 마주치는 실패(레이트리밋, 외부 API 변동, 멀티유저 데이터 꼬임)를 막는 **실무용 가드레일**이다.

## 0) 기본 목표
- 기능 추가보다 **신뢰성/확장성/관측성**이 우선일 때가 많다.
- “돌아간다”가 아니라 **운영에서 재현/추적/복구가 가능**해야 한다.

---

## (Ops) launchd / 포트 충돌(EADDRINUSE) 대응
- 현상: `server.js`가 `0.0.0.0:3000` bind 시, 이미 다른 인스턴스가 떠 있으면 `EADDRINUSE`로 크래시 → launchd `KeepAlive`로 재시작 루프가 생기며 로그만 쌓임.
- 원인 패턴: (1) 수동으로 `node server.js` 실행 후 launchd도 실행, (2) 재시작 타이밍 겹침.
- 조치(코드): `server.js`에서 `server.on('error')`로 `EADDRINUSE`를 잡고, `127.0.0.1:${PORT}/api/status/summary`가 응답하면 “이미 정상 서버가 떠 있음”으로 판단 → 프로세스를 유지(setInterval hold)해서 launchd 재시작 루프 방지.
- 관련 커밋: `fix(server): handle EADDRINUSE to avoid launchd crash loop`

## 1) 계층화 및 모듈 분리 (Separation of Concerns)
### Infrastructure Layer
외부 시스템/통신/저장소 의존이 있는 코드는 여기로 격리한다.
- 외부 API 클라이언트 (도매꾹 OpenAPI, 쿠팡 OpenAPI, 기타)
- DB 접근(sqlite, migrations)
- 파일 시스템(세션 파일, 이미지 캐시, out 디렉토리 등)
- 네트워크/재시도/레이트리밋(fetchWithRetry 등)

### Domain Layer
순수 비즈니스 규칙/모델. **외부 시스템에 의존하지 않는다.**
- 가격 정책(마진율/고정 마진/최소가/라운딩)
- 추천 점수/필터링 규칙
- 업로드 정책(금지 키워드, 상세 이미지 최소 기준 등)

### Application Layer
도메인과 인프라를 엮는 실행 흐름 제어.
- 업로드 큐 처리, 워커/스케줄러
- 사용자 요청 핸들링(Controller)
- 트랜잭션(가능한 범위), 상태 전이(queued→running→success/failed)

---

## 2) 인터페이스 기반 개발 (Dependency Inversion)
- 특정 서비스/벤더를 직접 호출하지 말고, **추상 인터페이스**를 먼저 정의한다.
  - 예: `ProductSourceProvider`(도매꾹/도매매/기타), `MarketplacePublisher`(쿠팡/스마트스토어/기타)
- 구현체는 `DomeggookOpenApiProvider`, `DomeggookHtmlParserProvider`, `CoupangPublisher`처럼 분리해 교체 가능하게 한다.

---

## 3) 멀티 테넌시(Multi-tenancy) 필수 적용
- 모든 데이터 요청/세션/파일 저장은 반드시 `userId`를 포함한다.
- 전역 변수/싱글톤 세션 금지. 사용자별 독립 컨텍스트 보장.
- 경로 예시:
  - `data/vendor_sessions/<userId>/storageState.domeggook.json`

---

## 4) 복구 탄력성 및 관측성 (Resilience & Observability)
### Resilience
- 외부 API 장애/레이트리밋에 대비
  - 재시도(429/5xx), 백오프
  - 큐(순차 처리), 동시 실행 제한
  - 필요 시 Circuit Breaker(연속 실패 시 일정 시간 차단)

### Observability
- 주요 단계마다 Audit Log/이벤트를 남겨서 운영에서 추적 가능해야 한다.
  - 예: upload job의 stage/progress 기록
  - 실패 원인(error_code/error_message/detail) 저장

---

## 5) 자가 검토 및 기록
- 코드 작성 전/후 간단히 체크:
  1) 지금 변경이 인프라/도메인/애플리케이션 중 어디에 속하는가?
  2) 추상 인터페이스로 교체 가능하게 되어 있는가?
  3) userId가 모든 경로/레코드에 포함되는가?
  4) 실패 시 복구/재시도/관측이 가능한가?
- 아키텍처 변화가 있으면 본 문서를 업데이트한다.
