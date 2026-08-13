// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IpcFailure } from "../../../shared/errors.js";
import { importAssetFile, MAX_ASSET_FILE_BYTES, readAssetFile } from "./AssetFileSystem.js";
import { initializeVault } from "./VaultFileSystem.js";

const dirs: string[] = [];

async function makeVault(assetsDirectory = "assets"): Promise<{
  root: string;
  vaultId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "e1-asset-fs-"));
  dirs.push(root);
  const meta = await initializeVault(root, "测试库");
  if (assetsDirectory !== "assets") {
    const vaultJson = join(root, ".e1", "vault.json");
    const record = JSON.parse(await readFile(vaultJson, "utf8")) as Record<
      string,
      unknown
    >;
    record.assetsDirectory = assetsDirectory;
    await writeFile(vaultJson, JSON.stringify(record));
    await mkdir(join(root, assetsDirectory), { recursive: true });
  }
  return { root, vaultId: meta.vaultId };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AssetFileSystem.importAssetFile", () => {
  it("普通文件与中文文件名写入 assetsDirectory", async () => {
    const { root, vaultId } = await makeVault();
    const result = await importAssetFile({
      vaultRoot: root,
      vaultId,
      fileName: "架构 图.png",
      mimeType: "image/png",
      source: { kind: "bytes", data: new Uint8Array([1, 2, 3]) },
    });
    expect(result.relativePath).toBe("assets/架构 图.png");
    expect([...await readFile(join(root, result.relativePath))]).toEqual([1, 2, 3]);
  });

  it("同名冲突递增且原文件不变", async () => {
    const { root, vaultId } = await makeVault();
    const first = await importAssetFile({
      vaultRoot: root,
      vaultId,
      fileName: "foo.png",
      mimeType: "image/png",
      source: { kind: "bytes", data: new Uint8Array([1]) },
    });
    const second = await importAssetFile({
      vaultRoot: root,
      vaultId,
      fileName: "foo.png",
      mimeType: "image/png",
      source: { kind: "bytes", data: new Uint8Array([2]) },
    });
    expect(first.relativePath).toBe("assets/foo.png");
    expect(second.relativePath).toBe("assets/foo (2).png");
    expect([...await readFile(join(root, first.relativePath))]).toEqual([1]);
    expect([...await readFile(join(root, second.relativePath))]).toEqual([2]);
  });

  it("path 源复制进 assetsDirectory，且不覆盖同名", async () => {
    const { root, vaultId } = await makeVault();
    const srcDir = await mkdtemp(join(tmpdir(), "e1-asset-src-"));
    dirs.push(srcDir);
    const src = join(srcDir, "photo.png");
    await writeFile(src, Buffer.from([9, 8, 7]));
    const first = await importAssetFile({
      vaultRoot: root,
      vaultId,
      fileName: "photo.png",
      mimeType: "image/png",
      source: { kind: "path", absolutePath: src },
    });
    const second = await importAssetFile({
      vaultRoot: root,
      vaultId,
      fileName: "photo.png",
      mimeType: "image/png",
      source: { kind: "path", absolutePath: src },
    });
    expect(first.relativePath).toBe("assets/photo.png");
    expect(second.relativePath).toBe("assets/photo (2).png");
    expect([...await readFile(join(root, first.relativePath))]).toEqual([9, 8, 7]);
  });

  it("无扩展名与 Windows 保留名可导入", async () => {
    const { root, vaultId } = await makeVault();
    const noExt = await importAssetFile({
      vaultRoot: root,
      vaultId,
      fileName: "README",
      mimeType: "application/octet-stream",
      source: { kind: "bytes", data: new Uint8Array([1]) },
    });
    const reserved = await importAssetFile({
      vaultRoot: root,
      vaultId,
      fileName: "CON.png",
      mimeType: "image/png",
      source: { kind: "bytes", data: new Uint8Array([2]) },
    });
    expect(noExt.relativePath).toBe("assets/README");
    expect(reserved.relativePath).toBe("assets/CON_.png");
  });

  it("20MiB + 1 拒绝且不留文件", async () => {
    const { root, vaultId } = await makeVault();
    await expect(
      importAssetFile({
        vaultRoot: root,
        vaultId,
        fileName: "big.bin",
        mimeType: "application/octet-stream",
        source: { kind: "bytes", data: new Uint8Array(MAX_ASSET_FILE_BYTES + 1) },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(IpcFailure);
      expect((err as IpcFailure).code).toBe("INVALID_INPUT");
      return true;
    });
    await expect(readFile(join(root, "assets", "big.bin"))).rejects.toThrow();
  });

  it("自定义 assetsDirectory", async () => {
    const { root, vaultId } = await makeVault("media");
    const result = await importAssetFile({
      vaultRoot: root,
      vaultId,
      fileName: "a.png",
      mimeType: "image/png",
      source: { kind: "bytes", data: new Uint8Array([9]) },
    });
    expect(result.relativePath).toBe("media/a.png");
  });

  it("assetsDirectory 符号链接逃逸拒绝", async () => {
    const { root, vaultId } = await makeVault();
    const outside = await mkdtemp(join(tmpdir(), "e1-asset-out-"));
    dirs.push(outside);
    await rm(join(root, "assets"), { recursive: true, force: true });
    try {
      await symlink(outside, join(root, "assets"));
    } catch {
      return;
    }
    await expect(
      importAssetFile({
        vaultRoot: root,
        vaultId,
        fileName: "a.png",
        mimeType: "image/png",
        source: { kind: "bytes", data: new Uint8Array([1]) },
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof IpcFailure && (err as IpcFailure).code === "PATH_ESCAPE",
    );
  });
});

describe("AssetFileSystem.readAssetFile", () => {
  it("读回导入的字节", async () => {
    const { root, vaultId } = await makeVault();
    const imported = await importAssetFile({
      vaultRoot: root,
      vaultId,
      fileName: "a.png",
      mimeType: "image/png",
      source: { kind: "bytes", data: new Uint8Array([7, 8]) },
    });
    const read = await readAssetFile({
      vaultRoot: root,
      relativePath: imported.relativePath,
    });
    expect([...read.data]).toEqual([7, 8]);
  });
});
