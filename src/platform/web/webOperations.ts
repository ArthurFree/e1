/**
 * Web 平台操作支持矩阵（R007 阶段 4 §9；R008 Stage 0 R8-01 细分）：
 * Web 全部页面/标签/版本操作均已实现，全 true。组件经
 * useAppServices().operations 门控入口，不得判断平台名称。
 */
import type { RuntimeOperations } from "../../runtime/RuntimeOperations";

export const webOperations: RuntimeOperations = {
  workspace: {
    rename: true,
    favorite: true,
  },
  page: {
    document: {
      create: true,
      renameTitle: true,
      renameFile: true,
      move: true,
      trash: true,
      favorite: true,
    },
    group: {
      create: true,
      rename: true,
      move: true,
      trash: true,
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
