/**
 * R007 阶段 4（§9）：Desktop 操作支持矩阵。
 * 规则与 capabilities 一致：没有实现的操作必须保持 false，入口隐藏
 * 而不是点了才抛 NOT_IMPLEMENTED。
 *
 * R008 Stage 0（R8-01/§7.2）：page 按业务对象细分——Document 与 Group
 * 能力不同，分开表达：
 * - workspace.rename = false：本地库名取自 vault.json/目录名，重命名未实现；
 * - document.renameFile = false：Main IPC（note.renameFile）已就绪，但领域
 *   PageRepository 接口无此方法、UI 入口属 R011，本批不接线（R007 §4.4 P2）；
 * - document.move 仅 document → directory；
 * - group.rename/group.move = false：Main 无目录 rename/move IPC（R011），
 *   UI 必须隐藏入口且分组不可拖拽、F2 不触发重命名（G4/R008 §7.3）；
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
