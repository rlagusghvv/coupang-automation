import fs from 'node:fs';

import path from 'node:path';

const DEFAULT_CAPTURE_PATH = path.join(process.cwd(), 'data', 'coupang_meta_capture.jsonl');

function safeJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

export function getWingUploadedImages({ capturePath = DEFAULT_CAPTURE_PATH, imageType } = {}) {
  const out = [];
  try {
    if (!fs.existsSync(capturePath)) return out;
    const raw = fs.readFileSync(capturePath, 'utf-8');
    const lines = raw.trim().split(/\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const obj = safeJson(lines[i]);
      if (!obj) continue;
      if (obj.kind !== 'response') continue;
      const url = String(obj.url || '');
      if (!url.includes('/tenants/seller-web/file/image/upload/v2')) continue;
      const body = String(obj.body || '');
      const b = safeJson(body);
      if (!b || b.success !== true || !b.message) continue;
      const validateType = String(b.validateType || '').toUpperCase();
      if (imageType && validateType && validateType != String(imageType).toUpperCase()) continue;
      out.push({
        vendorPath: String(b.message),
        validateType: b.validateType,
        originalFileName: b.originalFileName,
        imageWidth: b.imageWidth,
        imageHeight: b.imageHeight,
        capturedAt: obj.t,
        url,
      });
      // stop early if lots
      if (out.length >= 20) break;
    }
  } catch {}
  return out;
}

export function getLastWingUploadedImage({ capturePath = DEFAULT_CAPTURE_PATH, imageType = 'REPRESENTATION' } = {}) {
  const list = getWingUploadedImages({ capturePath, imageType });
  return list[0] || null;
}
