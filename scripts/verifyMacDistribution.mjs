/**
 * R013 Stage 3：Gatekeeper / stapling / DMG / ZIP 分发正确性。
 *
 *   node scripts/verifyMacDistribution.mjs [path-to-E1.app]
 *
 * 会对 builder 目录中的 E1.app、release/*.dmg 内的 app、release/*.zip
 * 解压后的 app 分别执行 stapler validate 与 spctl --assess。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluateGatekeeper,
  isUnsignedCodesignFailure,
  parseSpctlAssess,
  parseStaplerValidate,
} from "./macTrustPolicy.mjs";
import { projectRoot } from "./macTrustPaths.mjs";
import { verifyAppSigning } from "./verifyMacSigning.mjs";
import { verifyAppEntitlements } from "./verifyMacEntitlements.mjs";
import {
  defaultPackagedAppPath,
  findReleaseArtifacts,
  requireSignedMode,
} from "./macTrustPaths.mjs";

export function runTool(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

export function assessGatekeeper(appPath, run = runTool) {
  const stapler = run("xcrun", ["stapler", "validate", appPath]);
  const staplerText = `${stapler.stdout}\n${stapler.stderr}`;
  const stapled = parseStaplerValidate(staplerText);
  const spctl = run("spctl", [
    "--assess",
    "--type",
    "execute",
    "--verbose=4",
    appPath,
  ]);
  const assessText = `${spctl.stdout}\n${spctl.stderr}`;
  const assess = parseSpctlAssess(assessText);
  const gate = evaluateGatekeeper(assess);
  const errors = [];
  if (!stapled.ok) {
    errors.push(`stapler validate 失败：${staplerText.trim()}`);
  }
  if (spctl.status !== 0 || !gate.ok) {
    errors.push(
      ...(gate.errors.length > 0
        ? gate.errors
        : [`spctl 失败：${assessText.trim()}`]),
    );
  }
  return {
    ok: errors.length === 0,
    errors,
    source: assess.source,
    accepted: assess.accepted,
  };
}

export function verifyDistributedApp(appPath, options = {}) {
  const signing = verifyAppSigning(appPath, options);
  if (!signing.ok) return signing;
  const entitlements = verifyAppEntitlements(appPath, options);
  if (!entitlements.ok) return entitlements;
  const gate = assessGatekeeper(appPath, options.runTool ?? runTool);
  if (!gate.ok) return gate;
  return { ok: true, errors: [], source: gate.source };
}

function mountDmg(dmgPath) {
  const result = spawnSync(
    "hdiutil",
    ["attach", "-nobrowse", "-readonly", "-plist", dmgPath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    return { ok: false, error: `${result.stderr}\n${result.stdout}` };
  }
  const mountPoint = result.stdout.match(
    /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/,
  )?.[1];
  if (!mountPoint) {
    return { ok: false, error: "DMG 挂载成功但未解析到 mount-point" };
  }
  return { ok: true, mountPoint };
}

function detachDmg(mountPoint) {
  spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], { encoding: "utf8" });
}

function locateAppUnder(root) {
  const found = spawnSync("find", [root, "-name", "E1.app", "-type", "d"], {
    encoding: "utf8",
  });
  return (
    found.stdout
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

export function verifyDmg(dmgPath, options = {}) {
  const mounted = (options.mountDmg ?? mountDmg)(dmgPath);
  if (!mounted.ok) {
    return { ok: false, errors: [`挂载 DMG 失败：${mounted.error}`] };
  }
  try {
    const appPath = locateAppUnder(mounted.mountPoint);
    if (!appPath) {
      return { ok: false, errors: [`DMG 内未找到 E1.app：${dmgPath}`] };
    }
    return verifyDistributedApp(appPath, options);
  } finally {
    (options.detachDmg ?? detachDmg)(mounted.mountPoint);
  }
}

export function verifyZip(zipPath, options = {}) {
  const tmpRoot = path.join(projectRoot(), "test-results/tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const tmp = mkdtempSync(path.join(tmpRoot, "e1-zip-verify-"));
  try {
    const unzip = spawnSync("ditto", ["-x", "-k", zipPath, tmp], {
      encoding: "utf8",
    });
    if (unzip.status !== 0) {
      return {
        ok: false,
        errors: [`解压 ZIP 失败：${unzip.stderr || unzip.stdout}`],
      };
    }
    const appPath = locateAppUnder(tmp);
    if (!appPath) {
      return { ok: false, errors: [`ZIP 内未找到 E1.app：${zipPath}`] };
    }
    return verifyDistributedApp(appPath, options);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const required = requireSignedMode();
  const appPath = path.resolve(process.argv[2] ?? defaultPackagedAppPath());
  if (process.platform !== "darwin") {
    if (required) {
      console.error("正式 Release 分发校验必须在 macOS 上运行");
      process.exit(1);
    }
    console.log("skip: stapler/spctl 仅 macOS 可用");
    process.exit(0);
  }
  if (!existsSync(appPath)) {
    if (required) {
      console.error(`缺少安装包产物：${appPath}`);
      process.exit(1);
    }
    console.log(`skip: 缺少 ${appPath}`);
    process.exit(0);
  }

  const errors = [];
  const app = verifyDistributedApp(appPath);
  if (!app.ok) errors.push(...app.errors.map((error) => `app: ${error}`));

  const artifacts = findReleaseArtifacts();
  if (required && artifacts.dmgs.length === 0) {
    errors.push("正式 Release 缺少 DMG");
  }
  if (required && artifacts.zips.length === 0) {
    errors.push("正式 Release 缺少 ZIP");
  }
  for (const dmg of artifacts.dmgs) {
    const result = verifyDmg(dmg);
    if (!result.ok)
      errors.push(...result.errors.map((error) => `dmg: ${error}`));
  }
  for (const zip of artifacts.zips) {
    const result = verifyZip(zip);
    if (!result.ok)
      errors.push(...result.errors.map((error) => `zip: ${error}`));
  }

  if (errors.length > 0) {
    if (!required && isUnsignedCodesignFailure(errors.join("\n"))) {
      console.log("skip: 本地 unsigned 产物（正式 Release 将强制公证）");
      process.exit(0);
    }
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(
    `distribution valid: app + ${artifacts.dmgs.length} dmg + ${artifacts.zips.length} zip`,
  );
}
