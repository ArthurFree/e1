/**
 * 跨标签页同步事件契约（R004 阶段 7 §7.2；R005 阶段 8 §8.3 起经
 * ChangeChannel port 传输，application/services/ChangeChannel.ts 的
 * ApplicationChangeEvent 为本类型的平台无关别名）。
 * 事件类型是稳定契约：发送方（工作区动作、正文提交、偏好写入）与
 * 接收方（镜像刷新、正文重载、冲突提示）共享，Web 传输实现见
 * platform/web/BroadcastChangeChannel。
 */
import type { ContentVersionToken } from "./types";

/** 跨标签页同步事件。 */
export type AppSyncEvent =
  /** 知识库级变更：切换知识库或知识库内结构数据变化。 */
  | { type: "workspace-changed"; workspaceId: string }
  /** 页面级变更：页面 CRUD（新建/重命名/删除/移动/恢复/清空回收站等）。 */
  | { type: "page-changed"; workspaceId: string; pageId: string }
  /** 正文落盘：version 为写入后的新版本令牌（不透明 ContentVersionToken，R005 阶段 3）。 */
  | { type: "content-saved"; pageId: string; version: ContentVersionToken }
  /** 偏好变更：主题 / 侧栏宽度 / AI 配置（不含路由 lastRoute）。 */
  | { type: "preferences-changed" };
