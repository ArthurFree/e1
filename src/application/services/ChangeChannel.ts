/**
 * 变更广播频道 port（R005 阶段 8 §8.3）：同一应用多实例（浏览器多标签页、
 * 未来桌面多窗口/文件监听）之间广播工作区/页面/正文/偏好变更，
 * 接收方增量刷新本地镜像，避免「另一实例改了数据，本实例直到刷新才看到」。
 *
 * 事件类型复用 domain/sync.ts 的 AppSyncEvent（R004 阶段 7 契约），
 * ApplicationChangeEvent 为其平台无关别名，避免消费方大改。
 *
 * 平台实现：
 * - Web：src/platform/web/BroadcastChangeChannel.ts（BroadcastChannel +
 *   tabId 回声抑制；无 BroadcastChannel 环境降级 no-op）；
 * - Desktop（未来）：Electron IPC + 文件监听事件。
 *
 * 本 port 只定义传输语义：发送点（命令服务、DocumentCommitService、
 * PreferencesService 落盘回调、WorkspaceProvider 会话动作）与接收处理
 * （各 Provider / MainArea 订阅）在装配层接线。
 */
import type { AppSyncEvent } from "../../domain/sync";

/** 应用变更事件：与 domain/sync.ts 的 AppSyncEvent 同义（R005 阶段 8 §8.3）。 */
export type ApplicationChangeEvent = AppSyncEvent;

/** 变更事件回调。 */
export type ChangeCallback = (event: ApplicationChangeEvent) => void;

export interface ChangeChannel {
  /** 广播变更事件；no-op 实现静默丢弃。发送失败不得影响本地动作主流程。 */
  publish(event: ApplicationChangeEvent): void;
  /** 订阅变更事件；返回退订函数。实现方可过滤自身回声与非法数据。 */
  subscribe(callback: ChangeCallback): () => void;
}
