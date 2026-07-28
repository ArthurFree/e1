/**
 * ContentRepository 乐观并发契约——IndexedDB 实现（R004 阶段 7）。
 * 契约断言见 src/test/contentSaveContract.ts（与内存实现共用）。
 */
import { beforeEach } from "vitest";
import { describeContentSaveContract } from "../test/contentSaveContract";
import { getDB, resetDB, STORE_CONTENTS } from "./db";
import {
  contentRepository,
  pageRepository,
  workspaceRepository,
} from "./repositories";

beforeEach(async () => {
  await resetDB();
});

describeContentSaveContract("IndexedDB", () => ({
  workspace: workspaceRepository,
  page: pageRepository,
  content: contentRepository,
  async seedLegacyContent(pageId, workspaceId) {
    // 直接写库，模拟 R004 阶段 7 之前落盘的记录（无 version 字段）。
    const db = await getDB();
    await db.put(STORE_CONTENTS, {
      pageId,
      workspaceId,
      contentJson: { type: "doc", content: [] },
      textSnapshot: "旧",
      updatedAt: Date.now(),
    });
  },
}));
