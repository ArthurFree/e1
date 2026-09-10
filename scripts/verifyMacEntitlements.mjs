/**
 * R013 Stage 3：校验 E1.app 及 nested executable 的 entitlement 白名单。
 *
 *   node scripts/verifyMacEntitlements.mjs [path-to-E1.app]
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluateEntitlements,
  isUnsignedCodesignFailure,
  parseEntitlementKeysFromPlist,
} from "./macTrustPolicy.mjs";
import { collectNestedMachO, runCodesign } from "./verifyMacSigning.mjs";
import { defaultPackagedAppPath, requireSignedMode } from "./macTrustPaths.mjs";

export function readEntitlementsXml(targetPath, codesign = runCodesign) {
  const result = codesign(["-d", "--entitlements", ":-", targetPath]);
  const xml = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0 && !xml.includes("<plist")) {
    return { ok: false, xml: "", error: xml.trim() };
  }
  return { ok: true, xml };
}

export function verifyAppEntitlements(appPath, options = {}) {
  const codesign = options.runCodesign ?? runCodesign;
  const targets = [appPath];
  const nested = (options.collectNested ?? collectNestedMachO)(appPath);
  if (!nested.ok) {
    return { ok: false, errors: [`枚举 nested code 失败：${nested.error}`] };
  }
  targets.push(...nested.files);

  const errors = [];
  for (const target of targets) {
    const dumped = readEntitlementsXml(target, codesign);
    if (!dumped.ok) {
      errors.push(
        `${path.relative(appPath, target) || "E1.app"} 无法读取 entitlements：${dumped.error}`,
      );
      continue;
    }
    const keys = parseEntitlementKeysFromPlist(dumped.xml);
    const requireRequired = target === appPath || target.endsWith(".app");
    const evaluated = evaluateEntitlements(keys, { requireRequired });
    if (!evaluated.ok) {
      const label =
        target === appPath ? "E1.app" : path.relative(appPath, target);
      errors.push(...evaluated.errors.map((error) => `${label}：${error}`));
    }
  }
  return { ok: errors.length === 0, errors, targetCount: targets.length };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const appPath = path.resolve(process.argv[2] ?? defaultPackagedAppPath());
  const required = requireSignedMode();
  if (!existsSync(appPath)) {
    if (required) {
      console.error(`缺少安装包产物：${appPath}`);
      process.exit(1);
    }
    console.log(`skip: 缺少 ${appPath}（本地未 dist:mac）`);
    process.exit(0);
  }
  if (process.platform !== "darwin") {
    if (required) {
      console.error("正式 Release entitlement 校验必须在 macOS 上运行");
      process.exit(1);
    }
    console.log("skip: codesign 仅 macOS 可用");
    process.exit(0);
  }

  const result = verifyAppEntitlements(appPath);
  if (!result.ok) {
    if (!required && isUnsignedCodesignFailure(result.errors.join("\n"))) {
      console.log("skip: 本地 unsigned 产物（正式 Release 将强制签名）");
      process.exit(0);
    }
    for (const error of result.errors) console.error(error);
    process.exit(1);
  }
  console.log(`entitlements valid: targets=${result.targetCount}`);
}
