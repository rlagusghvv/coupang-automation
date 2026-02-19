import { spawn } from "node:child_process";

function run(cmd, args, timeoutMs = 60000) {
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
      if (code === 0) return resolve({ ok: true, out, err });
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
 * - scale to fit within 1200x1200
 * - pad to square 1200x1200 with white background
 * - output JPEG (quality ~2)
 */
export async function normalizeImageForCoupang({ inputPath, outputPath }) {
  if (!inputPath || !outputPath) throw new Error("missing_path");

  // ffmpeg filter: scale to fit within 1200x1200, keep aspect;
  // then pad to exact 1200x1200.
  const vf =
    "scale=1200:1200:force_original_aspect_ratio=decrease,pad=1200:1200:(ow-iw)/2:(oh-ih)/2:white";

  await run("ffmpeg", [
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
