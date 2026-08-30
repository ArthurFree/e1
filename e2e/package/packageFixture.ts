// R009 Stage 3：Packaged App E2E 共享夹具。
// 与 repo 模式桌面 E2E（e2e/desktop.*.spec.ts，args:["."]）的唯一差异在 launch 目标：
// 这里启动 release/ 下的安装包可执行文件，全程不依赖仓库 node_modules——
// G5 的目的正是避免 repo node_modules 掩盖安装后缺失 runtime dependency。
// Vault/登记手法（.e1/vault.json + recent-vaults.json 预置，绕过原生目录选择器）
// 与 e2e/desktop.state.spec.ts 完全一致。
import { _electron as electron } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePackagedExecutable } from "../desktopArtifacts";

export interface PackageVaultFixture {
  vaultDir: string;
  userDataDir: string;
  vaultId: string;
  cleanup(): Promise<void>;
}

/** 创建隔离 Vault + userData（recent-vaults.json 预置登记，启动即自动进入）。 */
export async function createPackageVaultFixture(
  files: Array<[string, string | Buffer]>,
  vaultId: string,
): Promise<PackageVaultFixture> {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-pkg-"));
  const vaultName = path.basename(vaultDir);
  for (const [rel, content] of files) {
    const abs = path.join(vaultDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  await mkdir(path.join(vaultDir, ".e1"));
  await writeFile(
    path.join(vaultDir, ".e1", "vault.json"),
    JSON.stringify({
      format: "e1-vault",
      formatVersion: 1,
      vaultId,
      name: vaultName,
      createdAt: "2026-08-10T00:00:00.000Z",
      assetsDirectory: "assets",
      identityMode: "frontmatter",
    }),
  );
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-userdata-pkg-"));
  await writeFile(
    path.join(userDataDir, "recent-vaults.json"),
    JSON.stringify([
      {
        vaultId,
        absolutePath: vaultDir,
        displayName: vaultName,
        lastOpenedAt: "2026-08-10T00:00:00.000Z",
      },
    ]),
  );
  return {
    vaultDir,
    userDataDir,
    vaultId,
    async cleanup() {
      await rm(vaultDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

/**
 * 以安装包可执行文件启动（E1_USER_DATA_DIR 隔离设备级状态）。
 * 调用前必须先经 requirePackagedArtifact() 门禁，此处再兜底一次。
 */
export function launchPackaged(
  userDataDir: string,
  options: { args?: string[]; env?: Record<string, string> } = {},
): Promise<ElectronApplication> {
  const executablePath = resolvePackagedExecutable();
  if (!executablePath) {
    throw new Error(
      `当前平台 ${process.platform}/${process.arch} 无安装包产物约定`,
    );
  }
  return electron.launch({
    executablePath,
    args: options.args,
    env: {
      ...process.env,
      E1_USER_DATA_DIR: userDataDir,
      ...options.env,
    },
  });
}

/** 带 Frontmatter 稳定 id 的笔记 Markdown。 */
export function note(id: string, title: string, body: string): string {
  return ["---", `id: ${id}`, `title: ${title}`, "---", "", body, ""].join(
    "\n",
  );
}
