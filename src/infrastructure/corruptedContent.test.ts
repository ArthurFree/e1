/**
 * 损坏正文处理测试（R003 阶段 4）：
 * - 仓储读路径原样返回损坏 JSON，由校验层拦截（不直接进编辑器）；
 * - 恢复缓冲中的损坏正文被拒绝并清除；
 * - 损坏诊断记录的写入/读取/清除。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resetDB } from "./db";
import {
  contentRepository,
  pageRepository,
  workspaceRepository,
} from "./repositories";
import { parseDocumentContent } from "../domain/validation/documentContent";
import { isDomainError } from "../domain/errors";
import {
  readRecovery,
  writeRecovery,
} from "../application/services/documentRecovery";
import {
  clearCorruptedDiagnostic,
  readCorruptedDiagnostic,
  writeCorruptedDiagnostic,
} from "../application/services/corruptedDiagnostics";

describe("损坏正文", () => {
  beforeEach(async () => {
    await resetDB();
    localStorage.clear();
  });

  it("仓储原样返回损坏 JSON，校验层以 CORRUPTED_DOCUMENT 拦截", async () => {
    // save 要求页面存在（R004 阶段 5：从页面回写 workspaceId）。
    const ws = await workspaceRepository.create("测试库");
    const page = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    const bad = { type: "doc", content: [{ type: "evilNode" }] };
    await contentRepository.save(page.id, bad, "坏内容", "idb:1");
    const stored = await contentRepository.get(page.id);
    expect(stored).toBeDefined();
    const parsed = parseDocumentContent(stored!.contentJson);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(isDomainError(parsed.error, "CORRUPTED_DOCUMENT")).toBe(true);
    }
  });

  it("恢复缓冲中的损坏正文被拒绝并清除，合法内容不受影响", () => {
    writeRecovery({
      pageId: "p1",
      contentJson: { type: "doc", content: [{ type: "evilNode" }] },
      generation: 3,
      timestamp: Date.now(),
    });
    expect(readRecovery("p1")).toBeNull();
    expect(localStorage.getItem("pending-document-recovery:p1")).toBeNull();

    writeRecovery({
      pageId: "p2",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      generation: 1,
      timestamp: Date.now(),
    });
    expect(readRecovery("p2")).not.toBeNull();
  });

  it("诊断记录写入/读取/清除", () => {
    writeCorruptedDiagnostic({
      pageId: "p1",
      raw: { broken: true },
      error: "文档内容损坏：content[0] 类型非法",
      detectedAt: 1,
    });
    const record = readCorruptedDiagnostic("p1");
    expect(record?.error).toContain("类型非法");
    expect(record?.detectedAt).toBe(1);
    clearCorruptedDiagnostic("p1");
    expect(readCorruptedDiagnostic("p1")).toBeNull();
  });
});
