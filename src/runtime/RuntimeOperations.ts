/**
 * 运行时操作支持矩阵（R007 阶段 4 §9；R008 Stage 0 按 R8-01 精确化）。
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
 * R8-01：Operation Support 必须描述业务对象——document 与 group 的
 * 真实实现不同（如 Desktop 分组 rename/move 未实现），因此 page 组
 * 细分 document / group / trash 三个对象，禁止用模糊的扁平 page.move
 * 表达两种对象的能力。
 */
export interface RuntimeOperations {
  workspace: {
    /** 重命名知识库（Web 改名称记录；Desktop 库名取自 vault.json/目录名）。 */
    rename: boolean;
    /** 收藏/取消收藏知识库。 */
    favorite: boolean;
  };
  page: {
    /** 文档（document 页）操作。 */
    document: {
      /** 新建文档。 */
      create: boolean;
      /** 标题重命名（Title rename；Desktop 写 Frontmatter title）。 */
      renameTitle: boolean;
      /**
       * 物理文件名重命名（File rename，§4.4「重命名文件」）——
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
    /** 分组（group 页；Desktop = 真实目录）操作。 */
    group: {
      /** 新建分组（Desktop = 真实目录）。 */
      create: boolean;
      /** 分组重命名（Desktop 待 Main 目录 rename IPC，R011）。 */
      rename: boolean;
      /** 分组移动（Desktop 待 Main 目录 move IPC，R011）。 */
      move: boolean;
      /** 移入回收站。 */
      trash: boolean;
    };
    /** 回收站操作（对 document / group 条目一致）。 */
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
