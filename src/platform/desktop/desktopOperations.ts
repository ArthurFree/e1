/**
 * R007 阶段 4（§9）+ R008 Stage 0（R8-01）：Desktop 操作支持矩阵。
 * 规则与 capabilities 一致：没有实现的操作必须保持 false，入口隐藏
 * 而不是点了才抛 NOT_IMPLEMENTED。
 *
 * 当前边界：
 * - workspace.rename = false：本地库名取自 vault.json/目录名，重命名未实现；
 * - page.document.renameFile = false：Main IPC（note.renameFile）已就绪，
 *   但领域 PageRepository 接口无此方法、UI 入口属后续批次（§4.4 P2）；
 * - page.document.move = true：仅 document → directory；
 * - page.group.rename/move = false：分组即真实目录，Main 暂无目录
 *   rename/move IPC（R007 阶段 4 偏差 1，R011 跟进）；create/trash 已实现；
 * - revision.read/write = false：Desktop 版本历史为空实现，§8 要求隐藏入口。
 */
import type { RuntimeOperations } from "../../runtime/RuntimeOperations";

export const desktopOperations: RuntimeOperations = {
  workspace: {
    rename: false,
    favorite: true,
  },
  page: {
    document: {
      create: true,
      renameTitle: true,
      renameFile: false,
      move: true,
      trash: true,
      favorite: true,
    },
    group: {
      create: true,
      rename: false,
      move: false,
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
