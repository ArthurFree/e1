/**
 * R013 Stage 3：校验 E1.app 签名身份 / Hardened Runtime / nested code。
 *
 *   node scripts/verifyMacSigning.mjs [path-to-E1.app]
 *
 * E1_REQUIRE_SIGNED=1（正式 Release）：未签名或校验失败 → exit 1
 * 未设置：无产物或未签名 → 打印 skip 后 exit 0（本地 unsigned QA）
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PRODUCT_IDENTIFIER,
  evaluateSigningInfo,
  isUnsignedCodesignFailure,
  parseCodesignDisplay,
} from "./macTrustPolicy.mjs";
import { defaultPackagedAppPath, requireSignedMode } from "./macTrustPaths.mjs";

export function runCodesign(args, cwd) {
  return spawnSync("codesign", args, {
    encoding: "utf8",
    cwd,
  });
}

export function collectNestedMachO(appPath) {
  const result = spawnSync(
    "find",
    [
      appPath,
      "(",
      "-name",
      "*.app",
      "-o",
      "-name",
      "*.framework",
      "-o",
      "-name",
      "*.dylib",
      "-o",
      "-name",
      "*.so",
      "-o",
      "(",
      "-type",
      "f",
      "(",
      "-name",
      "*.dylib",
      "-o",
      "-name",
      "*.so",
      "-o",
      "-path",
      "*/Contents/MacOS/*",
      ")",
      ")",
      ")",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    return { ok: false, files: [], error: result.stderr || result.stdout };
  }
  const files = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file && file !== appPath);
  return { ok: true, files };
}

export function verifyAppSigning(appPath, options = {}) {
  const codesign = options.runCodesign ?? runCodesign;
  const deep = codesign([
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);
  if (deep.status !== 0) {
    return {
      ok: false,
      errors: [
        `codesign --verify --deep --strict 失败：${(deep.stderr || deep.stdout).trim()}`,
      ],
    };
  }

  const display = codesign(["-dv", "--verbose=4", appPath]);
  const info = parseCodesignDisplay(`${display.stdout}\n${display.stderr}`);
  const evaluated = evaluateSigningInfo(info, {
    identifier: options.identifier ?? PRODUCT_IDENTIFIER,
  });
  if (!evaluated.ok) return evaluated;

  const nested = (options.collectNested ?? collectNestedMachO)(appPath);
  if (!nested.ok) {
    return { ok: false, errors: [`枚举 nested code 失败：${nested.error}`] };
  }
  const nestedErrors = [];
  for (const file of nested.files) {
    const verify = codesign(["--verify", "--strict", file]);
    if (verify.status !== 0) {
      nestedErrors.push(
        `nested 签名无效：${path.relative(appPath, file)}：${(verify.stderr || verify.stdout).trim()}`,
      );
    }
  }
  if (nestedErrors.length > 0) {
    return { ok: false, errors: nestedErrors };
  }
  return { ok: true, errors: [], info, nestedCount: nested.files.length };
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
      console.error("正式 Release 签名校验必须在 macOS 上运行");
      process.exit(1);
    }
    console.log("skip: codesign 仅 macOS 可用");
    process.exit(0);
  }

  const result = verifyAppSigning(appPath);
  if (!result.ok) {
    if (!required && isUnsignedCodesignFailure(result.errors.join("\n"))) {
      console.log("skip: 本地 unsigned 产物（正式 Release 将强制签名）");
      process.exit(0);
    }
    for (const error of result.errors) console.error(error);
    process.exit(1);
  }
  console.log(
    `signing valid: identifier=${result.info.identifier} team=${result.info.teamIdentifier} nested=${result.nestedCount}`,
  );
}
