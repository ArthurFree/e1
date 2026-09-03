/**
 * R010 Stage 2：双提取器一致性契约测试。
 *
 * shared/ 环境中立、不得 import src，因此本测试放在 codec 旁边：
 * 每条契约语料（shared/links/extractLinksFixtures.ts）经项目 MarkdownCodec
 * 解析为 Tiptap JSON 后跑 extractDocumentLinks（保存侧），与直接对
 * Markdown 源文本跑 extractMarkdownLinks（索引侧）的结果按
 * href+kind+fragment+targetRelativePath+label+knownTargetPageId 全字段比对。
 *
 * 当前语料不含 mention/internalLink 节点，两侧 knownTargetPageId 恒为
 * null，可断言完全相等。codec（marked）对 href 不做改写（实测：中文、
 * %20、平衡括号、尖括号空格路径均按原文/去尖括号保留，题注剥离——
 * Markdown 提取器同样剥离尖括号并忽略题注），因此无需归一直接比对。
 */
import { describe, expect, it } from "vitest";

import {
  extractDocumentLinks,
  type ExtractedLink,
} from "../../../shared/links/extractDocumentLinks.js";
import { LINK_EXTRACTION_FIXTURES } from "../../../shared/links/extractLinksFixtures.js";
import { extractMarkdownLinks } from "../../../shared/links/extractMarkdownLinks.js";
import { createMarkdownCodec } from "./index";

/** 稳定排序键：全字段拼接，便于比对多重集合。 */
function sortKey(link: ExtractedLink): string {
  return [
    link.kind,
    link.href,
    link.label,
    link.fragment ?? "",
    link.targetRelativePath ?? "",
    link.knownTargetPageId ?? "",
  ].join("␟");
}

function sorted(links: ExtractedLink[]): ExtractedLink[] {
  return [...links].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

describe("extractDocumentLinks 与 extractMarkdownLinks 输出一致", () => {
  const codec = createMarkdownCodec();

  for (const fixture of LINK_EXTRACTION_FIXTURES) {
    it(`语料「${fixture.name}」`, async () => {
      const parsed = await codec.parse({
        markdown: fixture.markdown,
        relativePath: fixture.sourceRelativePath,
      });
      const fromJson = extractDocumentLinks(
        parsed.document,
        fixture.sourceRelativePath,
      );
      const fromMarkdown = extractMarkdownLinks(
        fixture.markdown,
        fixture.sourceRelativePath,
      );
      expect(sorted(fromMarkdown)).toEqual(sorted(fromJson));
    });
  }
});
