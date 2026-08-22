/**
 * 运行时操作支持矩阵（R007 阶段 4 §9，G4 收口；R008 Stage 0 §7.2 精确化）。
 *
 * 与 RuntimeCapabilities 的分工：
 *
 *   Capability = runtime 能做什么（底层平台能力，如 fileWatching）；
 *   Operation  = 当前产品允许用户做什么（UI 是否显示该操作入口）。
 *
 * 不为每个动作继续膨胀 RuntimeCapabilities 的 boolean；UI 一律经
 * useAppServices().operations 门控入口（DUAL-01：不判断平台名称）。
 * 未支持的动作必须保持 false（诚实失败原则与 capabilities 一致）：
 * 入口隐藏，而不是点了才抛 NOT_IMPLEMENTED。
 *
 * R008 Stage 0（R8-01）：page 操作按业务对象细分为 document / group /
 * trash 三组——Document 与 Group 的实现能力不同（Desktop 分组重命名/
 * 移动未实现），不能用单个 page.move/page.renameTitle 模糊表达；
 * UI 按页面 kind 取对应组门控，不得自己判断平台名称。
 */
export interface RuntimeOperations {
  workspace: {
    /** 重命名知识库（Web 改名称记录；Desktop 库名取自 vault.json/目录名）。 */
    rename: boolean;
    /** 收藏/取消收藏知识库。 */
    favorite: boolean;
  };
  page: {
    /** 文档（Markdown 文件）操作。 */
    document: {
      /** 新建文档。 */
      create: boolean;
      /** 标题重命名（Title rename；Desktop 写 Frontmatter title）。 */
      renameTitle: boolean;
      /**
       * 物理文件名重命名（File rename，R007 §4.4「重命名文件」）——
       * 与标题重命名是两个独立概念，UI 入口必须分开命名。
       */
      renameFile: boolean;
      /** 移动文档（Desktop 第一版仅 document → directory，不支持自定义排序）。 */
      move: boolean;
      /** 移入回收站。 */
      trash: boolean;
      /** 收藏/取消收藏文档。 */
      favorite: boolean;
    };
    /** 分组（Desktop = 真实目录）操作。 */
    group: {
      /** 新建分组。 */
      create: boolean;
      /** 分组重命名（目录 rename；Desktop 待 Main 目录 IPC，R011）。 */
      rename: boolean;
      /** 分组移动（目录 move；Desktop 未实现，R011）。 */
      move: boolean;
      /** 移入回收站。 */
      trash: boolean;
    };
    /** 回收站操作（对 deletedAt 非空的页面）。 */
    trash: {
      /** 从回收站恢复。 */
      restore: boolean;
      /** 永久删除（含清空回收站）。 */
      purge: boolean;
    };
  };
  tag: {
    /** 标签写入（create / setPageTags）。 */
    write: boolean;
  };
  revision: {
    /** 读取版本历史（false 时 UI 必须隐藏版本历史入口，§8）。 */
    read: boolean;
    /** 写入版本快照。 */
    write: boolean;
  };
}
