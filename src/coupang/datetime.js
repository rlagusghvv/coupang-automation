export function signedDateUTC() {
  const d = new Date();
  const yy = String(d.getUTCFullYear()).slice(2);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    yy +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}
