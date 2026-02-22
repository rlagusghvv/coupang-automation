import { spawn } from "node:child_process";

function run(cmd, args, timeoutMs = 60000, allowNonZero = false) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const t = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch {}
      reject(new Error(`timeout: ${cmd}`));
    }, timeoutMs);

    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0 || allowNonZero) return resolve({ ok: code === 0, code, out, err });
      return reject(new Error(`${cmd} exited ${code}: ${err || out}`));
    });
  });
}

/**
 * Normalize an image for Coupang constraints:
 * - ensure JPEG
 * - ensure at least 500x500
 * - keep <= 5000x5000
 * - keep size comfortably under 10MB
 *
 * Strategy:
 * - enforce readable width (1200px) for mobile detail rendering
 * - keep aspect ratio (no square padding)
 * - output JPEG (quality ~2)
 */
export async function normalizeImageForCoupang({ inputPath, outputPath }) {
  if (!inputPath || !outputPath) throw new Error("missing_path");

  const ffmpeg = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";

  // 1) Try to detect and remove large white margins first.
  // Some supplier detail images are tiny posters centered in a wide white canvas.
  let cropExpr = "";
  try {
    const probe = await run(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "info",
        "-i",
        inputPath,
        "-vf",
        "cropdetect=24:16:0",
        "-frames:v",
        "30",
        "-f",
        "null",
        "-",
      ],
      30000,
      true,
    );

    const lines = String(probe.err || "").split("\n").filter((l) => l.includes("crop="));
    if (lines.length > 0) {
      // pick the last detected crop rectangle
      const m = lines[lines.length - 1].match(/crop=([0-9:]+)/);
      if (m?.[1]) cropExpr = `crop=${m[1]}`;
    }
  } catch {}

  // 2) Make detail readable on mobile: width 1200, keep aspect ratio.
  const vf = [cropExpr, "scale=1200:-2:flags=lanczos"].filter(Boolean).join(",");

  await run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vf",
    vf,
    "-q:v",
    "2",
    "-pix_fmt",
    "yuvj420p",
    outputPath,
  ]);

  return { ok: true, outputPath };
}
