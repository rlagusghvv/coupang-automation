function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatPercent(v) {
  return `${Math.round(Number(v || 0) * 100)}%`;
}

export function evaluateQcGate(preview = {}, settings = {}) {
  const minFilteredImages = num(settings.qcMinFilteredImages, 3);
  const minTokenMatchRate = num(settings.qcMinTokenMatchRate, 0.35);
  const maxRejectedRate = num(settings.qcMaxRejectedRate, 0.75);
  const maxHostDiversity = num(settings.qcMaxHostDiversity, 4);
  const minMainTokenCount = num(settings.qcMinMainTokenCount, 2);

  const metrics = {
    imageCountRaw: num(preview.imageCountRaw, 0),
    imageCountFiltered: num(preview.imageCountFiltered, 0),
    imageCountRejected: num(preview.imageCountRejected, 0),
    tokenMatchRate: num(preview.tokenMatchRate, 0),
    rejectedRate: num(preview.rejectedRate, 0),
    hostDiversityRaw: num(preview.hostDiversityRaw, 0),
    hostDiversityFiltered: num(preview.hostDiversityFiltered, 0),
    mainImageTokenCount: num(preview.mainImageTokenCount, 0),
    strictMode: Boolean(preview.strictMode),
  };

  const reasons = [];

  if (!preview.mainImageUrl) {
    reasons.push("대표 이미지가 비어 있습니다.");
  }

  if (metrics.mainImageTokenCount < minMainTokenCount) {
    reasons.push(
      `대표 이미지 식별 토큰이 부족합니다 (${metrics.mainImageTokenCount}/${minMainTokenCount}).`,
    );
  }

  if (metrics.imageCountFiltered < minFilteredImages) {
    reasons.push(
      `상세 이미지가 너무 적습니다 (${metrics.imageCountFiltered}/${minFilteredImages}).`,
    );
  }

  if (metrics.imageCountRaw > 0 && metrics.tokenMatchRate < minTokenMatchRate) {
    reasons.push(
      `대표-상세 이미지 토큰 일치율이 낮아 혼입 위험이 큽니다 (${formatPercent(metrics.tokenMatchRate)} < ${formatPercent(minTokenMatchRate)}).`,
    );
  }

  if (metrics.rejectedRate > maxRejectedRate && metrics.imageCountRejected >= 3) {
    reasons.push(
      `상세 이미지 차단 비율이 높습니다 (${formatPercent(metrics.rejectedRate)} > ${formatPercent(maxRejectedRate)}).`,
    );
  }

  if (
    metrics.hostDiversityRaw > maxHostDiversity &&
    metrics.imageCountRaw >= 5 &&
    metrics.tokenMatchRate < Math.min(0.9, minTokenMatchRate + 0.15)
  ) {
    reasons.push(
      `상세 이미지 호스트 분산도가 높습니다 (hosts=${metrics.hostDiversityRaw}, match=${formatPercent(metrics.tokenMatchRate)}).`,
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    metrics,
  };
}
