/**
 * ChangeChannel 的 Web 实现（R005 阶段 8 §8.3）：同一浏览器的多个标签页
 * 之间经 BroadcastChannel 广播应用变更事件（R004 阶段 7 §7.2 起的行为不变）。
 *
 * - 传输层为 BroadcastChannel（同源、同浏览器多标签页共享）；
 * - 每条消息带来源 tabId，接收方忽略自己发出的事件（回声抑制）——
 *   因此发送点可以放在动作内部，无需区分「本地动作 / 远端刷新」；
 * - jsdom 或老浏览器无 BroadcastChannel 时构造为 no-op（功能降级，
 *   单标签页行为不受影响）；测试可注入 mock channel。
 *
 * 本类自 application/services/SyncChannelService.ts 迁入并更名，
 * post 统一更名为 publish（对齐 ChangeChannel port）；信封格式、事件
 * 契约与多标签页行为保持不变。
 */
import type {
  ApplicationChangeEvent,
  ChangeCallback,
  ChangeChannel,
} from "../../application/services/ChangeChannel";

export type { ApplicationChangeEvent } from "../../application/services/ChangeChannel";

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
  event: ApplicationChangeEvent;
}

function isApplicationChangeEvent(
  data: unknown,
): data is ApplicationChangeEvent {
  if (!data || typeof data !== "object") return false;
  const type = (data as { type?: unknown }).type;
  return (
    type === "workspace-changed" ||
    type === "page-changed" ||
    type === "content-saved" ||
    type === "preferences-changed"
  );
}

export class BroadcastChangeChannel implements ChangeChannel {
  /** 本标签页 ID：回声抑制依据。 */
  readonly tabId: string;
  /** 订阅者集合：底层 onmessage 单槽位，由本服务多路分发。 */
  private readonly handlers = new Set<ChangeCallback>();
  private listening = false;

  constructor(
    private readonly channel: BroadcastChannelLike | null,
    tabId: string,
  ) {
    this.tabId = tabId;
  }

  /** 创建生产实例；环境无 BroadcastChannel 时返回 no-op 实例。 */
  static browser(tabId: string): BroadcastChangeChannel {
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? (new BroadcastChannel(
            SYNC_CHANNEL_NAME,
          ) as unknown as BroadcastChannelLike)
        : null;
    return new BroadcastChangeChannel(channel, tabId);
  }

  /** 广播事件（自动附来源 tabId）；no-op 实例静默丢弃。 */
  publish(event: ApplicationChangeEvent): void {
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
  subscribe(callback: ChangeCallback): () => void {
    const channel = this.channel;
    if (!channel) return () => {};
    this.handlers.add(callback);
    if (!this.listening) {
      this.listening = true;
      channel.onmessage = (msg) => this.dispatch(msg);
    }
    return () => {
      this.handlers.delete(callback);
    };
  }

  /** 解析信封并分发给所有订阅者；非法数据与自身回声在此过滤。 */
  private dispatch(msg: { data: unknown }): void {
    const data = msg.data as Partial<SyncEnvelope> | null;
    if (
      !data ||
      typeof data.source !== "string" ||
      data.source === this.tabId ||
      !isApplicationChangeEvent(data.event)
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

  /** 关闭底层频道（应用卸载/测试清理；装配根生命周期用，不在 port 上）。 */
  close(): void {
    this.channel?.close();
  }
}
