// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeDesktopAssetId } from "../../../shared/assets/desktopAssetId.js";
import { serveE1Asset } from "./serveE1Asset.js";
import { initializeVault } from "../filesystem/VaultFileSystem.js";
import { importAssetFile } from "../filesystem/AssetFileSystem.js";
import { VaultRegistry } from "../vaultRegistry.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe("serveE1Asset", () => {
  it("合法 asset → 200；missing → 404；伪造/绝对路径 → 400", async () => {
    const root = await mkdtemp(join(tmpdir(), "e1-proto-"));
    const user = await mkdtemp(join(tmpdir(), "e1-proto-ud-"));
    dirs.push(root, user);
    const meta = await initializeVault(root, "库");
    const registry = new VaultRegistry(join(user, "recent-vaults.json"));
    await registry.touch({
      vaultId: meta.vaultId,
      absolutePath: root,
      displayName: "库",
    });
    const imported = await importAssetFile({
      vaultRoot: root,
      vaultId: meta.vaultId,
      fileName: "a.png",
      mimeType: "image/png",
      source: { kind: "bytes", data: new Uint8Array([1, 2]) },
    });
    const ok = await serveE1Asset(
      `e1-asset://asset/${encodeURIComponent(imported.assetId)}`,
      { registry },
    );
    expect(ok.status).toBe(200);
    expect([...(ok.data ?? [])]).toEqual([1, 2]);

    const missingId = encodeDesktopAssetId(meta.vaultId, "assets/gone.png");
    const missing = await serveE1Asset(
      `e1-asset://asset/${encodeURIComponent(missingId)}`,
      { registry },
    );
    expect(missing.status).toBe(404);

    const forged = await serveE1Asset("e1-asset://asset/not-valid", {
      registry,
    });
    expect(forged.status).toBe(400);

    const abs = await serveE1Asset("e1-asset:///Users/foo.png", { registry });
    expect(abs.status).toBe(400);
  });
});
