// @vitest-environment node
/**
 * FullTextSearchIndexPort 契约套件 × Desktop/Main 真实实现（R008 Stage 4
 * §17.2 双实现契约的另一方；内存参照实现一方见
 * src/infrastructure/memory/fullTextSearchIndex.test.ts）。
 *
 * 真实 node:sqlite 临时库（每实例独立 mkdtemp），经 DesktopSearchService
 * 完整链路（schema 建库 → bigram FTS 召回 → 契约层精排）复跑
 * src/test/searchIndexContract.ts 全部 14 组断言（含中文验收语料）。
 *
 * rebuild 语义对齐：契约套件的 rebuild 期望「从留存源文档重新派生」
 * （内存实现同口径），故注入「库存快照回读」source——生产 source
 * （VaultSearchDocumentSource，Vault 扫描正文真相）由
 * electron/main/search/ 单测与 Desktop E2E 覆盖。
 *
 * 分层说明：本文件是 dependency-cruiser src-no-electron 规则的唯一豁免
 * （双实现契约要求同一套件驱动 Main 实现）；node:sqlite 需 Node ≥22.5
 * （@vitest-environment node；Electron 43 内置 Node 24 已验证 FTS5 可用）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { DesktopSearchService } from "../../electron/main/search/DesktopSearchService.js";
import { describeFullTextSearchIndexContract } from "./searchIndexContract";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describeFullTextSearchIndexContract(
  "Desktop/Main（node:sqlite）",
  async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "e1-search-contract-"));
    tempDirs.push(baseDir);
    const service = new DesktopSearchService({
      baseDir,
      // 契约 rebuild = 从留存源文档重新派生（内存参照实现同语义）：
      // source 回读库存快照；生产 source 为 Vault 扫描（见文件头注释）。
      source: { load: (vaultId) => service.snapshotDocuments(vaultId) },
    });
    return service;
  },
);
