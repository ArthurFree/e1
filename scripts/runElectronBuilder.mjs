/**
 * R013：本地 unsigned QA 与正式 Release 签名构建的唯一分流点。
 *
 * 默认（本地）：
 *   CSC_IDENTITY_AUTO_DISCOVERY=false + mac.identity=null
 *   → npm run package:desktop / dist:mac 不需要 Apple 证书
 *
 * 正式 Release（E1_RELEASE_SIGNING=1）：
 *   禁止 identity=null，forceCodeSigning + notarize
 *   凭证由 release.yml 写入 env（CSC_LINK / APPLE_API_KEY*）
 *
 *   node scripts/runElectronBuilder.mjs --dir
 *   node scripts/runElectronBuilder.mjs --mac --publish never
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { stripSigningEnv } from "./macTrustPolicy.mjs";

const require = createRequire(import.meta.url);

export function buildElectronBuilderArgs(argv, env = process.env) {
  const release = env.E1_RELEASE_SIGNING === "1";
  const passthrough = argv.filter((arg) => arg !== "--");
  const args = [...passthrough];
  let childEnv = { ...env };

  if (release) {
    args.push("--config.forceCodeSigning=true");
    args.push("--config.mac.notarize=true");
    delete childEnv.CSC_IDENTITY_AUTO_DISCOVERY;
  } else {
    childEnv = stripSigningEnv(childEnv);
    childEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    args.push("--config.mac.identity=null");
  }

  return { args, env: childEnv, release };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { args, env } = buildElectronBuilderArgs(process.argv.slice(2));
  const cli = require.resolve("electron-builder/cli.js");
  const result = spawnSync(process.execPath, [cli, ...args], {
    stdio: "inherit",
    env,
  });
  process.exit(result.status ?? 1);
}
