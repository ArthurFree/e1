/**
 * 共享挂载入口（R005 阶段 2，Bootstrap 拆分）：React 树装配与渲染的
 * 平台无关部分。Web 装配根（main.web.tsx）与未来 Desktop 装配根共用
 * 本入口；平台差异只经 AppServices 容器（含 capabilities）注入。
 * 本文件不得 import infrastructure（架构测试强制）。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../App";
import { AppServicesProvider } from "../state/AppServicesProvider";
import type { AppServices } from "../application/AppServices";
import "../styles/index.css";
import "katex/dist/katex.min.css";

/** 把应用挂载到指定 DOM 节点；服务容器由平台装配根构造后注入。 */
export function mountApplication(
  element: HTMLElement,
  services: AppServices,
): void {
  createRoot(element).render(
    <StrictMode>
      <AppServicesProvider services={services}>
        <App />
      </AppServicesProvider>
    </StrictMode>,
  );
}
