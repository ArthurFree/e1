/**
 * Web 平台操作支持矩阵（R007 阶段 4 §9）：Web 全部页面/标签/版本操作
 * 均已实现，全 true。组件经 useAppServices().operations 门控入口，
 * 不得判断平台名称。
 */
import type { RuntimeOperations } from "../../runtime/RuntimeOperations";

export const webOperations: RuntimeOperations = {
  workspace: {
    rename: true,
    favorite: true,
  },
  page: {
    createDocument: true,
    createGroup: true,
    renameTitle: true,
    renameFile: true,
    move: true,
    trash: true,
    restore: true,
    purge: true,
    favorite: true,
  },
  tag: {
    write: true,
  },
  revision: {
    read: true,
    write: true,
  },
};
