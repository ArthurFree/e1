/**
 * Web 用户反馈通道（R005 阶段 5）：暂以 window.alert 实现，保持既有
 * 提示文案与时机不变；后续接入统一 toast 组件时只替换本实现。
 */
import type { NotificationService } from "../../application/assets/assetServices";

export class WebNotificationService implements NotificationService {
  notify(message: string): void {
    window.alert(message);
  }
}
