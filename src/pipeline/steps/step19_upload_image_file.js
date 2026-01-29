import fs from "node:fs";
import path from "node:path";
import { coupangRequest } from "../../coupang/client.js";
import { COUPANG_VENDOR_ID } from "../../config/env.js";

// Node 18+ : global FormData, Blob 존재
function fileToFormData(filePath) {
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  const fileName = path.basename(filePath);
  fd.append("image", new Blob([buf], { type: "image/jpeg" }), fileName);
  // 어떤 API는 field명이 "file"일 수도 있어서 같이 넣어둠(서버가 무시해도 OK)
  fd.append("file", new Blob([buf], { type: "image/jpeg" }), fileName);
  return fd;
}

async function tryUpload(filePath) {
  const fd = fileToFormData(filePath);

  // Wing에서 쓰는 경로가 계정/버전별로 달라서 후보를 여러 개 찍어본다.
  const candidates = [
    "/v2/providers/seller_api/apis/api/v1/marketplace/images",
    "/v2/providers/seller_api/apis/api/v1/marketplace/images/upload",
    "/v2/providers/seller_api/apis/api/v1/marketplace/vendor-inventories/images",
    "/v2/providers/seller_api/apis/api/v1/marketplace/vendor-inventories/images/upload",
  ];

  for (const p of candidates) {
    const res = await coupangRequest({
      method: "POST",
      path: p,
      query: `vendorId=${encodeURIComponent(COUPANG_VENDOR_ID)}`,
      // coupangRequest가 JSON 전용이면 여기서 막힘 → 그 경우 client.js에 multipart 지원 추가해야 함
      body: fd,
      // 아래 헤더는 coupangRequest가 그대로 전달할 때만 의미 있음
      headers: {
        // FormData는 boundary를 자동으로 붙여야 해서 content-type 수동 지정하면 오히려 깨질 수 있음
      },
      rawBody: true, // (네 client 구현에 따라 무시될 수 있음)
    });

    console.log("\n=== TRY PATH:", p, "===");
    console.log("STATUS:", res.status);
    console.log("BODY:", res.body);

    // 200이면서 vendorPath/cdnPath 같은 게 오면 성공으로 보고 끝
    if (res.status === 200) {
      try {
        const j = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
        if (j?.data?.vendorPath || j?.data?.cdnPath || j?.data) {
          console.log("✅ UPLOAD OK. parsed:", j);
          return;
        }
      } catch {}
    }
  }

  console.log("\n❌ Upload failed for all candidate endpoints.");
  console.log("👉 이 경우 coupangRequest(client.js)가 FormData(multipart)를 못 보내는 구조일 확률이 큼.");
}

const filePath = process.argv[2];
if (!filePath) {
  console.log("Usage: node src/pipeline/steps/step19_upload_image_file.js <local_image_path>");
  process.exit(1);
}

await tryUpload(filePath);
