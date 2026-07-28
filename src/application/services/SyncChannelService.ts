/**
 * 跨标签页同步频道（R004 阶段 7 §7.2）：同一浏览器的多个标签页之间
 * 广播工作区/页面/正文/偏好变更，接收方增量刷新本地镜像，
 * 避免「另一标签页改了数据，本标签页直到刷新才看到」。
 *
 * - 传输层为 BroadcastChannel（同源、同浏览器多标签页共享）；
 * - 每条消息带来源 tabId，接收方忽略自己发出的事件（回声抑制）——
 *   因此发送点可以放在动作内部，无需区分「本地动作 / 远端刷新」；
 * - jsdom 或老浏览器无 BroadcastChannel 时构造为 no-op（功能降级，
 *   单标签页行为不受影响）；测试可注入 mock channel。
 *
 * 本服务只做传输：发送点（WorkspaceProvider 动作、DocumentCommitService、
 * PreferencesService）与接收处理（各 Provider / MainArea 订阅）在装配层接线。
 */
import type { AppSyncEvent } from "../../domain/sync";

export type { AppSyncEvent } from "../../domain/sync";

/** 频道名：全应用固定，跨标签页一致。 */
export const SYNC_CHANNEL_NAME = "notion-like-web-sync";

/** BroadcastChannel 的最小结构子集：便于测试注入 mock。 */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** 线上消息信封：事件 + 来源标签页 ID。 */
interface SyncEnvelope {
  source: string;
  event: AppSyncEvent;
}

function isAppSyncEvent(data: unknown): data is AppSyncEvent {
  if (!data || typeof data !== "object") return false;
  const type = (data as { type?: unknown }).type;
  return (
    type === "workspace-changed" ||
    type === "page-changed" ||
    type === "content-saved" ||
    type === "preferences-changed"
  );
}

export class SyncChannelService {
  /** 本标签页 ID：回声抑制依据。 */
  readonly tabId: string;
  /** 订阅者集合：底层 onmessage 单槽位，由本服务多路分发。 */
  private readonly handlers = new Set<(event: AppSyncEvent) => void>();
  private listening = false;

  constructor(
    private readonly channel: BroadcastChannelLike | null,
    tabId: string,
  ) {
    this.tabId = tabId;
  }

  /** 创建生产实例；环境无 BroadcastChannel 时返回 no-op 实例。 */
  static browser(tabId: string): SyncChannelService {
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? (new BroadcastChannel(
            SYNC_CHANNEL_NAME,
          ) as unknown as BroadcastChannelLike)
        : null;
    return new SyncChannelService(channel, tabId);
  }

  /** 广播事件（自动附来源 tabId）；no-op 实例静默丢弃。 */
  post(event: AppSyncEvent): void {
    if (!this.channel) return;
    const envelope: SyncEnvelope = { source: this.tabId, event };
    try {
      this.channel.postMessage(envelope);
    } catch {
      // 频道已关闭等异常不影响本地动作主流程。
    }
  }

  /**
   * 订阅其他标签页的事件（自己发出的不回声）；返回退订函数。
   * 多个订阅者共享同一底层频道（onmessage 单槽位由本服务多路分发）；
   * no-op 实例不会收到任何事件。
   */
  subscribe(handler: (event: AppSyncEvent) => void): () => void {
    const channel = this.channel;
    if (!channel) return () => {};
    this.handlers.add(handler);
    if (!this.listening) {
      this.listening = true;
      channel.onmessage = (msg) => this.dispatch(msg);
    }
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** 解析信封并分发给所有订阅者；非法数据与自身回声在此过滤。 */
  private dispatch(msg: { data: unknown }): void {
    const data = msg.data as Partial<SyncEnvelope> | null;
    if (
      !data ||
      typeof data.source !== "string" ||
      data.source === this.tabId ||
      !isAppSyncEvent(data.event)
    ) {
      return;
    }
    for (const handler of this.handlers) {
      try {
        handler(data.event);
      } catch {
        // 单个订阅者异常不影响其余订阅者。
      }
    }
  }

  /** 关闭底层频道（应用卸载/测试清理）。 */
  close(): void {
    this.channel?.close();
  }
}
