/**
 * R007 / R011 / R012：Desktop 操作支持矩阵。
 * R011 完成后：workspace.rename / document.renameFile / group.rename+move
 * 全部翻 true（测绿后开启）。
 * R012 Stage 6（需求 §29）：S2–S5 的 list/get/preview/capture/restore/
 * retention 全部测绿后，revision.read/write 翻 true（版本历史入口
 * 与创建/恢复能力在 Desktop 开放）。
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
    read: true,
    write: true,
  },
};
