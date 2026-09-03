/**
 * R010 Stage 3（§6/§11）：LinkIndex 契约套件——内存参照实现与 Desktop
 * SQLite 实现必须通过同一组语义断言：目标解析/broken 裁决、backlinks
 * 聚合、upsert/remove 幂等、目标删除标记与恢复、relocate 身份保持与
 * 重锚定、relocate/upsert 驱动恢复、rebuild 一致性、重复标题按身份区分、
 * 状态机与跨 Vault 隔离。
 *
 * 语料覆盖：稳定 id / path 双身份、中文路径、百分号编码路径、fragment、
 * external/asset/anchor、.. 逃逸、重复标题。
 */
import { describe, expect, it } from "vitest";
import {
  buildExtractedLink,
  type ExtractedLink,
} from "./extractDocumentLinks.js";
import type { LinkIndex, LinkIndexDocument } from "./LinkIndex.js";

const VAULT = "v-contract";

/** 经真实提取器语义构造链接条目（路径归一/分类与生产一致）。 */
function link(href: string, label: string, from: string): ExtractedLink {
  const built = buildExtractedLink(href, label, from);
  if (!built) throw new Error(`契约语料构造失败（空 href）：${href}`);
  return built;
}

function doc(
  partial: Partial<LinkIndexDocument> & { noteKey: string },
): LinkIndexDocument {
  return {
    vaultId: VAULT,
    stableNoteId: null,
    relativePath: `${partial.noteKey}.md`,
    title: partial.noteKey,
    versionToken: `sha256:${partial.noteKey}`,
    links: [],
    ...partial,
  };
}

/** 契约语料（确定性）。甲/乙同题（重复标题按身份区分）；乙为 path 身份。 */
export function linkContractCorpus(): LinkIndexDocument[] {
  return [
    doc({
      noteKey: "01AAA",
      stableNoteId: "01AAA",
      relativePath: "甲.md",
      title: "同名文档",
      links: [
        link("乙.md", "到乙", "甲.md"),
        link("缺失.md", "到缺失", "甲.md"),
        link("https://example.com", "外链", "甲.md"),
        link("assets/图.png", "附图", "甲.md"),
        link("#小节", "锚点", "甲.md"),
        link("../逃逸.md", "逃逸", "甲.md"),
        link("子目录/丙.md#部分", "到丙", "甲.md"),
      ],
    }),
    doc({
      noteKey: "path:乙.md",
      relativePath: "乙.md",
      title: "同名文档",
      links: [
        link("甲.md", "回甲", "乙.md"),
        // 百分号编码的中文路径：解码后归一到 子目录/丙.md。
        link("%E5%AD%90%E7%9B%AE%E5%BD%95/%E4%B8%99.md", "编码到丙", "乙.md"),
      ],
    }),
    doc({
      noteKey: "01CCC",
      stableNoteId: "01CCC",
      relativePath: "子目录/丙.md",
      title: "丙",
      links: [link("../甲.md", "到甲", "子目录/丙.md")],
    }),
  ];
}

export interface LinkIndexContractContext {
  createIndex(): LinkIndex;
  /** 重建语料（实现需要显式供给 documents 时经此参数）。 */
  rebuild(index: LinkIndex, docs: LinkIndexDocument[]): Promise<void>;
  /** 供给/更新「磁盘」文档（upsert 的读取来源，DSK-02：实现自读盘）。 */
  putDocument(document: LinkIndexDocument): void;
  /** 从「磁盘」删除（upsert 返回 indexed=false 场景）。 */
  removeDocument(vaultId: string, relativePath: string): void;
}

export function runLinkIndexContract(
  name: string,
  ctx: LinkIndexContractContext,
): void {
  const corpus = linkContractCorpus();

  async function readyIndex(): Promise<LinkIndex> {
    const index = ctx.createIndex();
    await ctx.rebuild(index, corpus);
    // upsert 走「磁盘」：语料同步供给为数据源。
    for (const document of corpus) ctx.putDocument(document);
    return index;
  }

  describe(`LinkIndex 契约（${name}）`, () => {
    it("getOutgoing：文档顺序返回，kind/fragment/目标解析与 broken 裁决", async () => {
      const index = await readyIndex();
      const outgoing = await index.getOutgoing({
        vaultId: VAULT,
        noteKey: "01AAA",
      });
      expect(
        outgoing.map((l) => [l.label, l.kind, l.targetPageId, l.broken]),
      ).toEqual([
        ["到乙", "internal", "path:乙.md", false],
        ["到缺失", "internal", null, true],
        ["外链", "external", null, false],
        ["附图", "asset", null, false],
        ["锚点", "anchor", null, false],
        ["逃逸", "internal", null, true],
        ["到丙", "internal", "01CCC", false],
      ]);
      // 归一路径 / fragment / sourceVersion 落库形态。
      expect(outgoing[3]).toMatchObject({
        targetRelativePath: "assets/图.png",
      });
      expect(outgoing[4]).toMatchObject({ fragment: "小节" });
      expect(outgoing[6]).toMatchObject({
        targetRelativePath: "子目录/丙.md",
        fragment: "部分",
        sourceVersion: "sha256:01AAA",
      });
      // .. 逃逸：targetRelativePath 为 null 且 broken。
      expect(outgoing[5]).toMatchObject({ targetRelativePath: null });
    });

    it("getBacklinks：按目标稳定键聚合 + sourceTitle + 百分号编码路径解析", async () => {
      const index = await readyIndex();
      const toA = await index.getBacklinks({
        vaultId: VAULT,
        noteKey: "01AAA",
      });
      expect(toA.map((b) => [b.sourcePageId, b.sourceTitle, b.href])).toEqual([
        ["01CCC", "丙", "../甲.md"],
        ["path:乙.md", "同名文档", "甲.md"],
      ]);
      const toC = await index.getBacklinks({
        vaultId: VAULT,
        noteKey: "01CCC",
      });
      expect(toC.map((b) => b.sourcePageId)).toEqual(["01AAA", "path:乙.md"]);
      // 未索引/无引用目标 → []。
      expect(
        await index.getBacklinks({ vaultId: VAULT, noteKey: "不存在" }),
      ).toEqual([]);
    });

    it("重复标题按身份区分（LINK-04：不按 title 定位）", async () => {
      const index = await readyIndex();
      const fromA = await index.getOutgoing({
        vaultId: VAULT,
        noteKey: "01AAA",
      });
      const fromB = await index.getOutgoing({
        vaultId: VAULT,
        noteKey: "path:乙.md",
      });
      expect(fromA.map((l) => l.sourcePageId)).toEqual(Array(7).fill("01AAA"));
      expect(fromB.map((l) => l.sourcePageId)).toEqual([
        "path:乙.md",
        "path:乙.md",
      ]);
    });

    it("getBrokenLinks：仅 internal 未解析目标（external/asset/anchor 不算）", async () => {
      const index = await readyIndex();
      const broken = await index.getBrokenLinks(VAULT);
      expect(broken.map((l) => l.label).sort()).toEqual(["到缺失", "逃逸"]);
      expect(broken.every((l) => l.broken && l.targetPageId === null)).toBe(
        true,
      );
    });

    it("upsert 幂等 + 更新后旧链接消失（sourceVersion 跟随新版本）", async () => {
      const index = await readyIndex();
      const v2 = doc({
        noteKey: "01AAA",
        stableNoteId: "01AAA",
        relativePath: "甲.md",
        title: "同名文档",
        versionToken: "sha256:甲-v2",
        links: [link("乙.md", "到乙v2", "甲.md")],
      });
      ctx.putDocument(v2);
      expect(
        await index.upsert({ vaultId: VAULT, relativePath: "甲.md" }),
      ).toEqual({ indexed: true });
      // 幂等：重复 upsert 不翻倍。
      await index.upsert({ vaultId: VAULT, relativePath: "甲.md" });
      const outgoing = await index.getOutgoing({
        vaultId: VAULT,
        noteKey: "01AAA",
      });
      expect(outgoing.map((l) => l.label)).toEqual(["到乙v2"]);
      expect(outgoing[0].sourceVersion).toBe("sha256:甲-v2");
      expect(await index.getBrokenLinks(VAULT)).toEqual([]);
    });

    it("upsert 已消失文件 → indexed=false（调用方按 remove 收口）", async () => {
      const index = await readyIndex();
      ctx.removeDocument(VAULT, "乙.md");
      expect(
        await index.upsert({ vaultId: VAULT, relativePath: "乙.md" }),
      ).toEqual({ indexed: false });
      // 索引中的既有条目不受影响（remove 由调用方显式触发）。
      expect(
        await index.getBacklinks({ vaultId: VAULT, noteKey: "path:乙.md" }),
      ).toHaveLength(1);
    });

    it("remove 幂等：目标删除 → 反向链接清空 + 指向它的链接翻 broken", async () => {
      const index = await readyIndex();
      await index.remove({ vaultId: VAULT, relativePath: "乙.md" });
      await index.remove({ vaultId: VAULT, relativePath: "乙.md" });
      expect(
        await index.getBacklinks({ vaultId: VAULT, noteKey: "path:乙.md" }),
      ).toEqual([]);
      const outgoing = await index.getOutgoing({
        vaultId: VAULT,
        noteKey: "01AAA",
      });
      expect(outgoing[0]).toMatchObject({
        label: "到乙",
        targetPageId: null,
        targetRelativePath: "乙.md",
        broken: true,
      });
      // 恢复：目标重新出现（upsert）→ broken 自动翻回。
      ctx.putDocument(corpus[1]);
      await index.upsert({ vaultId: VAULT, relativePath: "乙.md" });
      const recovered = await index.getOutgoing({
        vaultId: VAULT,
        noteKey: "01AAA",
      });
      expect(recovered[0]).toMatchObject({
        targetPageId: "path:乙.md",
        broken: false,
      });
    });

    it("relocate（path 身份）：身份随路径改写，指向它的链接同步更新，源文档出站链接重锚定", async () => {
      const index = await readyIndex();
      await index.relocate({
        vaultId: VAULT,
        fromRelativePath: "乙.md",
        toRelativePath: "归档/乙.md",
      });
      const outgoing = await index.getOutgoing({
        vaultId: VAULT,
        noteKey: "01AAA",
      });
      expect(outgoing[0]).toMatchObject({
        label: "到乙",
        targetPageId: "path:归档/乙.md",
        targetRelativePath: "归档/乙.md",
        broken: false,
      });
      expect(
        await index.getBacklinks({
          vaultId: VAULT,
          noteKey: "path:归档/乙.md",
        }),
      ).toHaveLength(1);
      expect(
        await index.getBacklinks({ vaultId: VAULT, noteKey: "path:乙.md" }),
      ).toEqual([]);
      // 源文档移入子目录后，相对 href 以新目录为基准重算 → 原目标解析不到。
      const moved = await index.getOutgoing({
        vaultId: VAULT,
        noteKey: "path:归档/乙.md",
      });
      expect(moved[0]).toMatchObject({
        label: "回甲",
        targetRelativePath: "归档/甲.md",
        targetPageId: null,
        broken: true,
      });
    });

    it("relocate（stable id 身份）：noteKey 不变，targetRelativePath 更新", async () => {
      const index = await readyIndex();
      await index.relocate({
        vaultId: VAULT,
        noteKey: "01CCC",
        fromRelativePath: "子目录/丙.md",
        toRelativePath: "归档/丙.md",
      });
      const toC = await index.getBacklinks({
        vaultId: VAULT,
        noteKey: "01CCC",
      });
      expect(toC.map((b) => b.sourcePageId)).toEqual(["01AAA", "path:乙.md"]);
      const outgoing = await index.getOutgoing({
        vaultId: VAULT,
        noteKey: "01AAA",
      });
      expect(outgoing[6]).toMatchObject({
        targetPageId: "01CCC",
        targetRelativePath: "归档/丙.md",
        broken: false,
      });
    });

    it("relocate 到 broken 链接的目标路径 → 自动恢复；原位置链接翻 broken", async () => {
      const index = await readyIndex();
      await index.relocate({
        vaultId: VAULT,
        fromRelativePath: "乙.md",
        toRelativePath: "缺失.md",
      });
      const outgoing = await index.getOutgoing({
        vaultId: VAULT,
        noteKey: "01AAA",
      });
      // 身份跟随文件：到乙 指向新位置。
      expect(outgoing[0]).toMatchObject({
        targetPageId: "path:缺失.md",
        targetRelativePath: "缺失.md",
        broken: false,
      });
      // 到缺失 因文件落位而恢复。
      expect(outgoing[1]).toMatchObject({
        targetPageId: "path:缺失.md",
        broken: false,
      });
      expect(await index.getBrokenLinks(VAULT)).toEqual([
        expect.objectContaining({ label: "逃逸" }),
      ]);
    });

    it("rebuild：旧条目清空重建，重建后结果一致", async () => {
      const index = await readyIndex();
      const only = doc({
        noteKey: "01ONLY",
        stableNoteId: "01ONLY",
        relativePath: "唯一.md",
        title: "唯一的文档",
        links: [link("不存在.md", "断链", "唯一.md")],
      });
      await ctx.rebuild(index, [only]);
      expect(
        await index.getOutgoing({ vaultId: VAULT, noteKey: "01AAA" }),
      ).toEqual([]);
      expect(
        await index.getBacklinks({ vaultId: VAULT, noteKey: "01AAA" }),
      ).toEqual([]);
      expect((await index.getBrokenLinks(VAULT)).map((l) => l.label)).toEqual([
        "断链",
      ]);
      expect(index.getStatus(VAULT)).toEqual({
        state: "ready",
        indexedDocuments: 1,
      });
    });

    it("状态机与跨 Vault 隔离：missing → ready；其它 vault 不受影响", async () => {
      const index = ctx.createIndex();
      expect(index.getStatus(VAULT).state).toBe("missing");
      await ctx.rebuild(index, corpus);
      expect(index.getStatus(VAULT)).toEqual({
        state: "ready",
        indexedDocuments: 3,
      });
      ctx.putDocument(
        doc({
          noteKey: "01OTHER",
          vaultId: "v-other",
          stableNoteId: "01OTHER",
          relativePath: "外部.md",
          links: [link("缺.md", "外部断链", "外部.md")],
        }),
      );
      await index.upsert({ vaultId: "v-other", relativePath: "外部.md" });
      expect(
        (await index.getBrokenLinks("v-other")).map((l) => l.label),
      ).toEqual(["外部断链"]);
      // 本 vault 的 broken 集不被污染（仍是 到缺失/逃逸）。
      expect(
        (await index.getBrokenLinks(VAULT)).map((l) => l.label).sort(),
      ).toEqual(["到缺失", "逃逸"]);
    });
  });
}
