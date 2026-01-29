function toNumber(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function computePrice(base) {
  const raw = Number(base);
  if (!Number.isFinite(raw)) return base;

  const rate = toNumber(process.env.PRICE_MARKUP_RATE, 0);
  const add = toNumber(process.env.PRICE_MARKUP_ADD, 0);
  const min = toNumber(process.env.PRICE_MIN, 1000);
  const max = toNumber(process.env.PRICE_MAX, Infinity);
  const roundUnit = toNumber(process.env.PRICE_ROUND_UNIT, 10);

  let price = raw + raw * rate + add;
  if (roundUnit > 1) price = Math.floor(price / roundUnit) * roundUnit;
  price = Math.max(min, price);
  price = Math.min(max, price);
  return price;
}
