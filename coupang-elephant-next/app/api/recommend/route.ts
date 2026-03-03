import { NextResponse } from "next/server";

function score(title: string) {
  // Deterministic pseudo-score for stable ordering in MVP.
  let s = 0;
  for (let i = 0; i < title.length; i++) s = (s * 31 + title.charCodeAt(i)) >>> 0;
  return s;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { keyword?: string } | null;
  const keyword = (body?.keyword ?? "").trim();
  if (!keyword) {
    return NextResponse.json({ ok: false, message: "키워드를 입력해 주세요." }, { status: 400 });
  }

  // MVP recommendation generator:
  // - Replace with real sourcing/ranking pipeline.
  // - Keep fields compatible with UI.
  const base = [
    `${keyword} 미니`,
    `${keyword} 대용량`,
    `${keyword} 휴대용`,
    `${keyword} 리필`,
    `${keyword} 세트`,
    `${keyword} 프리미엄`,
    `${keyword} 가성비`,
    `${keyword} 업그레이드`,
    `${keyword} 선물용`,
    `${keyword} 프로`,
  ];

  const candidates = base
    .map((t, idx) => {
      const id = `rec_${keyword.replace(/\s+/g, "_")}_${idx + 1}`;
      const sc = score(t);
      const effort = sc % 3 === 0 ? "낮음" : sc % 3 === 1 ? "중" : "높음";
      const competition = (sc >> 3) % 3 === 0 ? "낮음" : (sc >> 3) % 3 === 1 ? "중" : "높음";
      return {
        candidateId: id,
        title: t,
        reason: "MVP 추천(룰 기반). 실제 데이터/랭킹 파이프라인으로 교체 예정.",
        effort,
        competition,
        _score: sc,
      };
    })
    .sort((a, b) => a._score - b._score)
    .map(({ _score, ...rest }) => rest);

  return NextResponse.json({ ok: true, keyword, candidates });
}
