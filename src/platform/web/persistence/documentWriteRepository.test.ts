/**
 * DocumentWriteRepository 契约测试（IndexedDB 实现，fake-indexeddb）。
 * 断言共享自 src/test/documentWriteContract.ts。
 */
import { beforeEach } from "vitest";
import { resetDB } from "./db";
import {
  contentRepository,
  documentWriteRepository,
  pageRepository,
  workspaceRepository,
} from "./repositories";
import { describeDocumentWriteContract } from "../../../test/documentWriteContract";

beforeEach(async () => {
  await resetDB();
});

describeDocumentWriteContract("IndexedDB", () => ({
  workspace: workspaceRepository,
  page: pageRepository,
  content: contentRepository,
  documentWrite: documentWriteRepository,
}));
