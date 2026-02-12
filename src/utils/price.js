function toNumber(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function sanitizeCoupangPrice(input, { min = 1000, max = Infinity, roundUnit = 10 } = {}) {
  const n = Number(input);
  const safeMin = Number.isFinite(Number(min)) ? Number(min) : 1000;
  const safeMax = Number.isFinite(Number(max)) ? Number(max) : Infinity;
  let unit = Number(roundUnit);
  if (!Number.isFinite(unit) || unit < 1) unit = 1;

  if (!Number.isFinite(n)) return safeMin;

  let price = n;
  if (unit > 1) price = Math.floor(price / unit) * unit;
  price = Math.max(safeMin, price);
  price = Math.min(safeMax, price);
  // Coupang expects integer KRW.
  price = Math.floor(price);
  return Number.isFinite(price) ? price : safeMin;
}

export function computePrice(base, overrides = {}) {
  const raw = Number(base);
  const minFallback = toNumber(overrides.min ?? process.env.PRICE_MIN, 1000);
  if (!Number.isFinite(raw)) return minFallback;

  const rate = toNumber(overrides.rate ?? process.env.PRICE_MARKUP_RATE, 0);
  const add = toNumber(overrides.add ?? process.env.PRICE_MARKUP_ADD, 0);
  const min = toNumber(overrides.min ?? process.env.PRICE_MIN, 1000);
  const max = toNumber(overrides.max ?? process.env.PRICE_MAX, Infinity);
  let roundUnit = toNumber(overrides.roundUnit ?? process.env.PRICE_ROUND_UNIT, 10);
  if (!Number.isFinite(roundUnit) || roundUnit < 1) roundUnit = 10;

  let price = raw + raw * rate + add;
  if (roundUnit > 1) price = Math.floor(price / roundUnit) * roundUnit;
  price = Math.max(min, price);
  price = Math.min(max, price);

  return sanitizeCoupangPrice(price, { min, max, roundUnit: 1 });
}
