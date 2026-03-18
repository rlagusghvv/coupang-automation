function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatPercent(v) {
  return `${Math.round(Number(v || 0) * 100)}%`;
}

export function evaluateQcGate(preview = {}, settings = {}) {
  const minFilteredImages = num(settings.qcMinFilteredImages, 2);
  const minTokenMatchRate = num(settings.qcMinTokenMatchRate, 0.3);
  const maxRejectedRate = num(settings.qcMaxRejectedRate, 0.82);
  const maxHostDiversity = num(settings.qcMaxHostDiversity, 4);
  const minMainTokenCount = num(settings.qcMinMainTokenCount, 2);

  // path/asset quality guards
  const minPathAllowRate = num(settings.qcMinPathAllowRate, 0.08);
  const maxPathBlockedRate = num(settings.qcMaxPathBlockedRate, 0.82);
  const maxSuspiciousPathRate = num(settings.qcMaxSuspiciousPathRate, 0.72);
  const minExactHostRate = num(settings.qcMinExactHostRate, 0.05);

  // Trusted detail path mode:
  // some suppliers serve valid detail images on a dedicated CDN domain.
  // If path quality is clean enough, host/token mismatch should not hard-fail.
  const trustedPathAllowRate = num(settings.qcTrustedPathAllowRate, 0.9);
  const trustedPathBlockedRate = num(settings.qcTrustedPathBlockedRate, 0.15);
  const trustedSuspiciousRate = num(settings.qcTrustedSuspiciousRate, 0.1);
  const trustedFilteredMinCount = num(settings.qcTrustedFilteredMinCount, minFilteredImages);
  const trustedFilteredMaxBlockedRate = num(settings.qcTrustedFilteredMaxBlockedRate, 0.7);
  const trustedFilteredMaxRejectedRate = num(settings.qcTrustedFilteredMaxRejectedRate, 0.8);

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
    exactHostMatchRate: num(preview.exactHostMatchRate, 0),
    sameDomainRate: num(preview.sameDomainRate, 0),
    pathAllowRateRaw: num(preview.pathAllowRateRaw, 0),
    pathBlockedRateRaw: num(preview.pathBlockedRateRaw, 0),
    suspiciousPathRateRaw: num(preview.suspiciousPathRateRaw, 0),
    pathAllowCountRaw: num(preview.pathAllowCountRaw, 0),
    pathAllowCountFiltered: num(preview.pathAllowCountFiltered, 0),
    pathBlockedCountRaw: num(preview.pathBlockedCountRaw, 0),
    suspiciousPathCountRaw: num(preview.suspiciousPathCountRaw, 0),
    suspiciousPathCountFiltered: num(preview.suspiciousPathCountFiltered, 0),
    minimumOrderQty: Math.max(
      1,
      num(preview.minimumOrderQty ?? preview.purchaseConstraints?.minimumOrderQty, 1),
    ),
  };

  const openApiImagePassthrough = Boolean(preview.openApiImagePassthrough);
  if (openApiImagePassthrough) {
    const reasons = [];
    if (!preview.mainImageUrl) {
      reasons.push("대표 이미지가 비어 있습니다.");
    }
    // Passthrough mode is intentionally lenient: allow 1+ detail image.
    if (metrics.imageCountFiltered < 1) {
      reasons.push(`상세 이미지가 너무 적습니다 (${metrics.imageCountFiltered}/1).`);
    }
    return {
      ok: reasons.length === 0,
      reasons,
      metrics,
    };
  }

  const reasons = [];
  const trustedDetailAssetModeByRaw =
    metrics.imageCountRaw >= minFilteredImages &&
    metrics.imageCountFiltered >= minFilteredImages &&
    metrics.pathAllowRateRaw >= trustedPathAllowRate &&
    metrics.pathBlockedRateRaw <= trustedPathBlockedRate &&
    metrics.suspiciousPathRateRaw <= trustedSuspiciousRate;
  const trustedDetailAssetModeByFiltered =
    metrics.imageCountFiltered >= trustedFilteredMinCount &&
    metrics.pathAllowCountFiltered >= trustedFilteredMinCount &&
    metrics.suspiciousPathCountFiltered === 0 &&
    metrics.pathBlockedRateRaw <= trustedFilteredMaxBlockedRate &&
    metrics.rejectedRate <= trustedFilteredMaxRejectedRate;
  const trustedDetailAssetMode = trustedDetailAssetModeByRaw || trustedDetailAssetModeByFiltered;

  if (!preview.mainImageUrl) {
    reasons.push("대표 이미지가 비어 있습니다.");
  }

  if (metrics.minimumOrderQty > 1) {
    reasons.push(`최소주문수량이 ${metrics.minimumOrderQty}개라 단건 주문 처리에 맞지 않습니다.`);
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

  if (
    !trustedDetailAssetMode &&
    metrics.imageCountRaw > 0 &&
    metrics.tokenMatchRate < minTokenMatchRate
  ) {
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

  if (
    metrics.imageCountRaw >= 5 &&
    metrics.pathAllowRateRaw < minPathAllowRate &&
    metrics.tokenMatchRate < Math.min(0.9, minTokenMatchRate + 0.2)
  ) {
    reasons.push(
      `상품 상세 자산 경로 비율이 낮습니다 (allow=${formatPercent(metrics.pathAllowRateRaw)} < ${formatPercent(minPathAllowRate)}).`,
    );
  }

  if (metrics.imageCountRaw >= 5 && metrics.pathBlockedRateRaw > maxPathBlockedRate) {
    reasons.push(
      `공통/배너/SNS 경로 이미지 비율이 높습니다 (blocked=${formatPercent(metrics.pathBlockedRateRaw)} > ${formatPercent(maxPathBlockedRate)}).`,
    );
  }

  if (
    metrics.imageCountRaw >= 5 &&
    metrics.suspiciousPathRateRaw > maxSuspiciousPathRate &&
    metrics.tokenMatchRate < 0.75
  ) {
    reasons.push(
      `아이콘/배너성 이미지 비율이 높습니다 (suspicious=${formatPercent(metrics.suspiciousPathRateRaw)}).`,
    );
  }

  if (
    !trustedDetailAssetMode &&
    metrics.imageCountRaw >= 4 &&
    metrics.exactHostMatchRate < minExactHostRate &&
    metrics.tokenMatchRate < Math.min(0.9, minTokenMatchRate + 0.2)
  ) {
    reasons.push(
      `대표 이미지와 동일 호스트 비율이 낮습니다 (exactHost=${formatPercent(metrics.exactHostMatchRate)} < ${formatPercent(minExactHostRate)}).`,
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    metrics,
  };
}
