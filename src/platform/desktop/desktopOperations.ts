/**
 * R007 / R011：Desktop 操作支持矩阵。
 * R011 完成后：workspace.rename / document.renameFile / group.rename+move
 * 全部翻 true（测绿后开启）。
 */
import type { RuntimeOperations } from "../../runtime/RuntimeOperations";

export const desktopOperations: RuntimeOperations = {
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
    read: false,
    write: false,
  },
};
