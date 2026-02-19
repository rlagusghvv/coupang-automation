function _fmt(d, yearDigits) {
  const year = yearDigits === 4
    ? String(d.getUTCFullYear())
    : String(d.getUTCFullYear()).slice(2);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    year +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

// Default format (legacy): YYMMDDTHHMMSSZ
export function signedDateUTC() {
  return _fmt(new Date(), 2);
}

// No trailing Z (some gateways are picky)
export function signedDateUTCNoZ() {
  return signedDateUTC().replace(/Z$/, "");
}

// Alternative format some endpoints enforce: YYYYMMDDTHHMMSSZ
export function signedDateUTC4() {
  return _fmt(new Date(), 4);
}

export function signedDateUTC4NoZ() {
  return signedDateUTC4().replace(/Z$/, "");
}

