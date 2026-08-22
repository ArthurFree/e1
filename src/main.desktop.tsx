/**
 * Desktop 装配根（R006 阶段 1）：desktop.html 的入口，与 main.web.tsx
 * 同构——创建 Desktop 运行时（IPC-backed 适配 + 桌面能力矩阵）并经共享
 * bootstrap 挂载应用。getDesktopApi 在纯浏览器误开 desktop.html 时
 * 显式抛错（见 platform/desktop/desktopApi.ts）。
 *
 * R008 Stage 1（R8-02）：secretStorageStatus 是运行时探测值——先查
 * secret.status（本机安全后端模式）再装配，探测失败按 unavailable
 *（安全缺省：不声称安全持久化）。
 */
import { createDesktopRuntime } from "./platform/desktop/createDesktopRuntime";
import { getDesktopApi } from "./platform/desktop/desktopApi";
import { mountApplication } from "./bootstrap/mountApplication";

async function bootstrap(): Promise<void> {
  const api = getDesktopApi();
  const secretStatus = await api.secret
    .status()
    .catch(() => ({ mode: "unavailable" as const, reason: "状态探测失败" }));
  const runtime = createDesktopRuntime(api, { secretStatus });
  mountApplication(
    document.getElementById("root") as HTMLElement,
    runtime.services,
  );
}

void bootstrap();
