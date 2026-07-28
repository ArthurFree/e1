/**
 * DocumentWriteRepository 契约测试（内存实现）。
 * 与 IndexedDB 版跑同一契约套件，证明两实现语义一致（R004 阶段 2）。
 */
import { createInMemoryRepositories } from "./repositories";
import { describeDocumentWriteContract } from "../../test/documentWriteContract";

describeDocumentWriteContract("内存", () => {
  const repos = createInMemoryRepositories();
  return {
    workspace: repos.workspace,
    page: repos.page,
    content: repos.content,
    documentWrite: repos.documentWrite,
  };
});
