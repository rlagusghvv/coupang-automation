import { requestProductApproval } from "../../coupang/api/requestProductApproval.js";

const id = process.argv[2];
if (!id) {
  console.log("Usage: node src/pipeline/steps/step24_request_approval.js <sellerProductId>");
  process.exit(1);
}

const res = await requestProductApproval({ sellerProductId: id });
console.log("STATUS:", res.status);
console.log("BODY:", res.body);
