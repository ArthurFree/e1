/**
 * R013 Stage 6：正式 Release 签名预检。
 * 只输出 certificate/notary configured = yes/no，缺失即失败。
 * 禁止打印 secret 内容或长度。
 *
 *   node scripts/signingPreflight.mjs
 */
import { pathToFileURL } from "node:url";
import {
  evaluateSigningPreflight,
  formatPreflightLog,
} from "./macTrustPolicy.mjs";

export function runSigningPreflight(env = process.env) {
  const result = evaluateSigningPreflight(env);
  return { result, log: formatPreflightLog(result) };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { result, log } = runSigningPreflight();
  console.log(log);
  if (!result.ok) {
    console.error(
      "正式 Release 缺少签名或公证凭证，拒绝降级为 unsigned（TRUST-01/02）",
    );
    process.exit(1);
  }
}
