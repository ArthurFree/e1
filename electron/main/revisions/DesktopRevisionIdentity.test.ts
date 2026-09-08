// @vitest-environment node
/**
 * R012 Stage 1（需求 §17、§24）：DesktopRevisionIdentity 测试。
 * 覆盖：stable-id 派生与 rename 后系列连续、path-only 路径匹配与 relocate、
 * 外部移动不猜测、relocatePrefix 批量改前缀、奇异 stable id 退化。
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  relocateSeries,
  relocateSeriesPrefix,
  resolveSeries,
  seriesIdForStableNoteId,
} from "./DesktopRevisionIdentity.js";
import { resolveRevisionSeriesRoot } from "./DesktopRevisionStore.js";

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-revision-identity-"));
});

async function readSeriesJson(seriesId: string) {
  const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
  return JSON.parse(
    await readFile(join(seriesRoot, seriesId, "series.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("resolveSeries", () => {
  it("stable-id 文档：seriesId 确定性派生 sn_<stableNoteId>，series.json 落盘", async () => {
    const series = await resolveSeries(vaultRoot, {
      stableNoteId: "01JABCDEFGHJKMNPQRSTVWXYZ0",
      relativePath: "学习/React.md",
    });
    expect(series.seriesId).toBe("sn_01JABCDEFGHJKMNPQRSTVWXYZ0");
    expect(series.stableNoteId).toBe("01JABCDEFGHJKMNPQRSTVWXYZ0");
    expect(series.currentRelativePath).toBe("学习/React.md");

    const onDisk = await readSeriesJson(series.seriesId);
    expect(onDisk.seriesId).toBe(series.seriesId);
    expect(onDisk.version).toBe(1);
  });

  it("stable-id rename 后系列连续：同一 stableNoteId 解析到同一 series", async () => {
    const first = await resolveSeries(vaultRoot, {
      stableNoteId: "n-react",
      relativePath: "学习/React.md",
    });
    const second = await resolveSeries(vaultRoot, {
      stableNoteId: "n-react",
      relativePath: "存档/React 新版.md",
    });
    expect(second.seriesId).toBe(first.seriesId);
    // resolveSeries 只读：路径更新一律走 relocate，不静默改写。
    expect(second.currentRelativePath).toBe("学习/React.md");

    const moved = await relocateSeries(
      vaultRoot,
      { stableNoteId: "n-react" },
      "存档/React 新版.md",
    );
    expect(moved).toBe(true);
    const third = await resolveSeries(vaultRoot, {
      stableNoteId: "n-react",
      relativePath: "存档/React 新版.md",
    });
    expect(third.seriesId).toBe(first.seriesId);
    expect(third.currentRelativePath).toBe("存档/React 新版.md");
  });

  it("path-only 文档：随机 sp_ 系列；同路径复用，relocate 后新路径仍命中", async () => {
    const first = await resolveSeries(vaultRoot, {
      stableNoteId: null,
      relativePath: "日记/2026-09-07.md",
    });
    expect(first.seriesId).toMatch(/^sp_[0-9A-Z]{26}$/);
    expect(first.stableNoteId).toBeNull();

    const again = await resolveSeries(vaultRoot, {
      stableNoteId: null,
      relativePath: "日记/2026-09-07.md",
    });
    expect(again.seriesId).toBe(first.seriesId);

    // E1 内部 rename：按旧路径定位孤儿 series 并更新路径。
    const moved = await relocateSeries(
      vaultRoot,
      { fromRelativePath: "日记/2026-09-07.md" },
      "日记/2026-09-08.md",
    );
    expect(moved).toBe(true);
    const after = await resolveSeries(vaultRoot, {
      stableNoteId: null,
      relativePath: "日记/2026-09-08.md",
    });
    expect(after.seriesId).toBe(first.seriesId);
    expect(after.currentRelativePath).toBe("日记/2026-09-08.md");
  });

  it("外部移动且无 stable id：不猜测身份，找不到就新建", async () => {
    const first = await resolveSeries(vaultRoot, {
      stableNoteId: null,
      relativePath: "a.md",
    });
    // 文件被外部程序移动到 b.md（没有经过 relocate）。
    const second = await resolveSeries(vaultRoot, {
      stableNoteId: null,
      relativePath: "b.md",
    });
    expect(second.seriesId).not.toBe(first.seriesId);
  });

  it("奇异 stable id（含分隔符等目录不安全字符）→ 退化为 path-only", async () => {
    expect(seriesIdForStableNoteId("a/b")).toBeNull();
    expect(seriesIdForStableNoteId("..")).toBeNull();
    const series = await resolveSeries(vaultRoot, {
      stableNoteId: "a/b",
      relativePath: "x.md",
    });
    expect(series.seriesId).toMatch(/^sp_/);
    expect(series.stableNoteId).toBeNull();
  });
});

describe("relocateSeriesPrefix（分组 rename/move）", () => {
  it("命中前缀的 series 批量改路径，其余不动；快照目录不变", async () => {
    const stable = await resolveSeries(vaultRoot, {
      stableNoteId: "n-a",
      relativePath: "组/a.md",
    });
    const orphan = await resolveSeries(vaultRoot, {
      stableNoteId: null,
      relativePath: "组/子/b.md",
    });
    const outside = await resolveSeries(vaultRoot, {
      stableNoteId: "n-c",
      relativePath: "组外/c.md",
    });

    const updated = await relocateSeriesPrefix(vaultRoot, "组", "新组");
    expect(updated).toBe(2);

    expect((await readSeriesJson(stable.seriesId)).currentRelativePath).toBe(
      "新组/a.md",
    );
    expect((await readSeriesJson(orphan.seriesId)).currentRelativePath).toBe(
      "新组/子/b.md",
    );
    expect((await readSeriesJson(outside.seriesId)).currentRelativePath).toBe(
      "组外/c.md",
    );
    // 边界：前缀必须落在路径段上，"组外" 不得命中 "组"。
  });

  it("relocateSeries 未命中 → false（不报错）", async () => {
    expect(
      await relocateSeries(vaultRoot, { stableNoteId: "n-none" }, "x.md"),
    ).toBe(false);
    expect(
      await relocateSeries(vaultRoot, { fromRelativePath: "none.md" }, "x.md"),
    ).toBe(false);
  });
});
