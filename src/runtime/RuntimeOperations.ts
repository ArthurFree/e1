/**
 * 运行时操作支持矩阵（R007 阶段 4 §9，G4 收口）。
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
 */
export interface RuntimeOperations {
  workspace: {
    /** 重命名知识库（Web 改名称记录；Desktop 库名取自 vault.json/目录名）。 */
    rename: boolean;
    /** 收藏/取消收藏知识库。 */
    favorite: boolean;
  };
  page: {
    /** 新建文档。 */
    createDocument: boolean;
    /** 新建分组（Desktop = 真实目录）。 */
    createGroup: boolean;
    /** 标题重命名（Title rename；Desktop 写 Frontmatter title）。 */
    renameTitle: boolean;
    /**
     * 物理文件名重命名（File rename，§4.4「重命名文件」）——
     * 与标题重命名是两个独立概念，UI 入口必须分开命名。
     */
    renameFile: boolean;
    /** 移动页面（Desktop 第一版仅 document → directory，不支持自定义排序）。 */
    move: boolean;
    /** 移入回收站。 */
    trash: boolean;
    /** 从回收站恢复。 */
    restore: boolean;
    /** 永久删除（含清空回收站）。 */
    purge: boolean;
    /** 收藏/取消收藏页面。 */
    favorite: boolean;
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
