/**
 * Web 平台操作支持矩阵（R007 阶段 4 §9）：组件经
 * useAppServices().operations 门控入口，不得判断平台名称。
 * R008 Stage 0（R8-01）：page 细分 document/group/trash 三组。
 *
 * R011 Stage 0（R11-005，§26）：`page.document.renameFile` 的语义已冻结为
 * **物理文件名重命名**——Web 端页面存在 IndexedDB，没有磁盘文件名可改，
 * 因此该操作诚实置 false（入口隐藏），页面改名一律走 renameTitle。
 * R014：Web 无本地 Vault 根目录/跨库文件树，`workspace.relocate` 与
 * `copyToVault`/`moveToVault` 同样诚实置 false。这不是平台分支，而是
 * 操作矩阵对真实产品能力的诚实表达。
 */
import type { RuntimeOperations } from "../../runtime/RuntimeOperations";

export const webOperations: RuntimeOperations = {
  workspace: {
    rename: true,
    favorite: true,
    relocate: false,
  },
  page: {
    document: {
      create: true,
      renameTitle: true,
      // R011 §26：Web 无物理文件名（IndexedDB 持久化），入口隐藏。
      renameFile: false,
      move: true,
      trash: true,
      favorite: true,
      copyToVault: false,
      moveToVault: false,
    },
    group: {
      create: true,
      rename: true,
      move: true,
      trash: true,
      copyToVault: false,
      moveToVault: false,
    },
    trash: {
      restore: true,
      purge: true,
    },
  },
  tag: {
    write: true,
  },
  revision: {
    read: true,
    write: true,
  },
};
