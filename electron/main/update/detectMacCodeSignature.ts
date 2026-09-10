/**
 * R013：运行时探测当前打包 app 是否为 Developer ID + Hardened Runtime。
 * 仅看 codesign 显示信息，不读证书文件、不触碰 CSC_*。
 */
import { spawnSync } from "node:child_process";

export function resolveMacAppBundleFromExe(exePath: string): string | null {
  const marker = ".app/";
  const index = exePath.lastIndexOf(marker);
  if (index === -1) return null;
  return exePath.slice(0, index + ".app".length);
}

export function detectDarwinDeveloperIdSigned(
  exePath: string,
  run: typeof spawnSync = spawnSync,
): boolean {
  if (process.platform !== "darwin") return false;
  const bundle = resolveMacAppBundleFromExe(exePath);
  if (!bundle) return false;
  const verify = run("codesign", ["--verify", "--deep", "--strict", bundle], {
    encoding: "utf8",
  });
  if (verify.status !== 0) return false;
  const display = run("codesign", ["-dv", "--verbose=4", bundle], {
    encoding: "utf8",
  });
  const text = `${display.stdout}\n${display.stderr}`;
  return (
    /Authority=Developer ID Application/.test(text) &&
    (/\(runtime\)/.test(text) || /\bruntime\b/.test(text))
  );
}
