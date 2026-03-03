import { NextResponse } from "next/server";

function clampText(s: string, max = 120) {
  const t = (s || "").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { keyword?: string; category?: string; priceBand?: string }
    | null;

  const keyword = clampText(body?.keyword ?? "");
  const category = clampText(body?.category ?? "");
  const priceBand = clampText(body?.priceBand ?? "");

  if (!keyword) {
    return NextResponse.json(
      { ok: false, message: "키워드를 입력해 주세요." },
      { status: 400 },
    );
  }

  // MVP NOTE:
  // - 데이터 소스/크롤링/쿠팡 API 연동은 추후 단계.
  // - 오늘 안에 '돌아가게' 만들기 위해 deterministic mock 분석을 제공합니다.
  // - UI/근거 표시는 유지하고, 이후 실제 데이터로 교체합니다.
  const now = new Date();

  const signals = [
    {
      label: "검색 수요",
      value: "중",
      detail: "최근 7일 기준으로 유입 가능성이 있습니다.",
    },
    {
      label: "경쟁 강도",
      value: "중",
      detail: "상위 노출 경쟁이 있으나, 차별화로 진입 가능합니다.",
    },
    {
      label: "리뷰 진입장벽",
      value: "낮음",
      detail: "리뷰 수가 적은 틈새를 공략할 수 있습니다.",
    },
  ];

  const actions = [
    {
      title: "상세페이지 1차 구성",
      why: "리뷰/후기에서 반복되는 키워드를 상단 3개 섹션에 반영",
      impact: "전환율 개선",
    },
    {
      title: "가격대 테스트",
      why: "가격 밴드를 2단계(예: -3% / 기준)로 24시간 A/B",
      impact: "ROAS 안정화",
    },
    {
      title: "키워드 확장",
      why: "동의어/브랜드/사용상황 조합 10개를 광고/상세에 분산",
      impact: "노출 확대",
    },
  ];

  const result = {
    ok: true,
    keyword,
    category,
    priceBand,
    asOf: now.toISOString(),
    summary: {
      title: `“${keyword}” 10분 분석 결과`,
      subtitle: "(MVP) 샘플 데이터 기반 — 내일 실사용 테스트를 위해 UI/플로우 우선 제공",
      score: 72,
      recommendation: "테스트 진행 권장",
    },
    rationale: {
      sources: [
        {
          name: "샘플 데이터",
          note: "실데이터 연동 전까지는 형태/근거 표시만 유지",
        },
      ],
      assumptions: [
        "초기에는 수동 입력/샘플 데이터로 플로우를 검증",
        "이후 실제 데이터(크롤링/제휴 API/파트너 데이터)로 교체",
      ],
    },
    signals,
    actions,
  };

  return NextResponse.json(result);
}
