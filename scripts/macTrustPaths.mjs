/**
 * R013：安装包产物路径约定（macOS arm64）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

export function projectRoot() {
  return fileURLToPath(new URL("..", import.meta.url));
}

export function defaultPackagedAppPath() {
  return path.join(projectRoot(), "release/mac-arm64/E1.app");
}

export function defaultReleaseDir() {
  return path.join(projectRoot(), "release");
}

export function requireSignedMode(env = process.env) {
  return env.E1_REQUIRE_SIGNED === "1" || env.E1_RELEASE_SIGNING === "1";
}

export function findReleaseArtifacts(releaseDir = defaultReleaseDir()) {
  let names;
  try {
    names = readdirSync(releaseDir);
  } catch {
    return { dmgs: [], zips: [] };
  }
  return {
    dmgs: names
      .filter((name) => name.endsWith(".dmg"))
      .map((name) => path.join(releaseDir, name)),
    zips: names
      .filter((name) => name.endsWith(".zip") && !name.endsWith(".blockmap"))
      .map((name) => path.join(releaseDir, name)),
  };
}
