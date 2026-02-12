# 업로드를 ‘진짜 큐(Queue)’로 강제 — 1페이지 설계안 (쿠팡코끼리)

목표: 대량 업로드에서도 **깨지지 않게** 만들기
- 동시 실행/중복 클릭/409 혼란을 구조적으로 제거
- 완료/실패를 UI에서 “이유 포함”으로 확실히 보여주기

---

## 1) 핵심 아이디어
- 업로드 실행을 `/api/jobs/start` 같은 “즉시 실행” 모델에서
- **`enqueue → worker가 1개씩 처리`** 모델로 바꿈

### 원칙
- 사용자별(user_id) **동시 실행 1개 보장**
- 같은 URL은 **큐에서 dedupe** (중복 등록 방지)
- 실패는 “깨진 업로드”가 아니라 **실패 + 사유(messageKo/hint)**

---

## 2) 데이터 모델(기존 jobs 테이블 활용)
이미 `jobs` 테이블이 있음:
- `kind=upload`
- `status`: queued | running | succeeded | failed | cancelled
- `result_json`: 진행률, retryAtMs 등 확장
- `error_code`, `error_message`

추가로 필요하면(선택):
- `queue_group`(예: user_id) 개념은 논리적으로만 유지하고, 실제 동시성은 worker에서 강제

---

## 3) API 설계(최소)
### (1) Enqueue
- `POST /api/upload-queue/enqueue`
  - body: `{ url, force?, catalogId?, rename?: {prefix?, suffix?}, presetId?, ... }`
  - 동작:
    - (dedupe) `uploaded_products` 또는 `jobs(kind=upload, status in queued/running)`로 중복 체크
    - 중복이면 409 대신 **200 OK + {code: 'duplicate', messageKo, hint}**
    - 신규면 jobs에 `queued`로 insert

### (2) Queue 조회
- `GET /api/upload-queue/list?status=queued|running|...&limit=...`
  - UI에서 “대기/진행/완료/실패”를 한 화면에서 볼 수 있게

### (3) Cancel
- `POST /api/upload-queue/cancel { jobId }`
  - queued만 cancel 허용 (running은 안전상 불가 또는 soft-cancel)

### (4) Worker tick(내부)
- 서버 프로세스 내 setInterval 또는 별도 worker 프로세스
- `getNextQueuedJob(userId,'upload')`로 1건 가져와
- status=running으로 바꾸고 실제 업로드 파이프라인 실행
- 성공/실패 시 status 업데이트 + messageKo/hint 포함

---

## 4) UI/UX 흐름(앱/웹 공통)
- 다중 업로드 버튼 → 바로 실행이 아니라 **‘큐에 등록됨’** 토스트/리스트 반영
- 진행 표시: running job 1개 + queued N개
- 실패 표시: error_code를 사람말(messageKo/hint)로 표시
- 리네임: 다중 업로드는 개별 팝업 대신 **prefix/suffix 일괄 적용**(현재 방향 유지)

---

## 5) 기대 효과
- 409의 대부분이 구조적으로 사라짐(동시실행/중복클릭)
- 완료 표시/진행률이 “큐” 기준으로 단순화
- 운영 장애 시에도 queued 상태가 남아 재시도/재개 가능

---

## 6) 작업 순서(추천)
1) enqueue/list/cancel API 뼈대
2) worker 1개(사용자별) + running 단일 보장
3) 앱/웹에서 업로드 요청을 enqueue로 전환
4) messageKo/hint 표준화(에러코드 매핑)
5) 리포트/재시도 버튼(추가)
