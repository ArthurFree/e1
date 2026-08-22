/**
 * Desktop 装配根（R006 阶段 1）：desktop.html 的入口，与 main.web.tsx
 * 同构——创建 Desktop 运行时（IPC-backed 适配 + 桌面能力矩阵）并经共享
 * bootstrap 挂载应用。getDesktopApi 在纯浏览器误开 desktop.html 时
 * 显式抛错（见 platform/desktop/desktopApi.ts）。
 *
 * R007 阶段 5：nativeSecrets 是运行时探测值——先查 secret.status
 *（safeStorage 是否可用）再装配，探测失败按不可用处理（安全缺省）。
 */
import { createDesktopRuntime } from "./platform/desktop/createDesktopRuntime";
import { getDesktopApi } from "./platform/desktop/desktopApi";
import { mountApplication } from "./bootstrap/mountApplication";

async function bootstrap(): Promise<void> {
  const api = getDesktopApi();
  const status = await api.secret.status().catch(() => ({ available: false }));
  const runtime = createDesktopRuntime(api, {
    nativeSecrets: status.available,
  });
  mountApplication(
    document.getElementById("root") as HTMLElement,
    runtime.services,
  );
}

void bootstrap();
