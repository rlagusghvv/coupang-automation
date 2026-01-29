import crypto from "crypto";
import { signedDateUTC } from "./datetime.js";
import { COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY } from "../config/env.js";

export function buildAuthorization({ method, path, query = "" }) {
  const signedDate = signedDateUTC();
  const message = `${signedDate}${method}${path}${query}`;

  const signature = crypto
    .createHmac("sha256", COUPANG_SECRET_KEY)
    .update(message)
    .digest("hex");

  return {
    authorization: `CEA algorithm=HmacSHA256, access-key=${COUPANG_ACCESS_KEY}, signed-date=${signedDate}, signature=${signature}`,
    signedDate,
  };
}
