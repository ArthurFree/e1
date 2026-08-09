/**
 * 偏好状态 Provider（R004 阶段 4）：preferences 与路由持久化状态的
 * 所有者。消费装配根构造的 PreferencesService 单例（R005 批次 2，
 * 串行写入队列），卸载时 dispose（清侧栏防抖定时器并等待写入队列排空）、
 * 挂载时 resume 恢复写入。
 *
 * 除公开的 PreferencesContext（value 形状不变）外，还提供内部路由通道
 * PreferencesRouteContext 供导航域持久化路由、供初始加载等待偏好就绪——
 * 嵌套顺序（Preferences → Workspace → Navigation）保证内层可消费。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AIConfig, Preferences } from "../domain/types";
import { DEFAULT_PREFERENCES } from "../domain/types";
import { serializeRoute, type AppRoute } from "../domain/route";
import { useAppServices } from "./AppServicesProvider";
import {
  PreferencesContext,
  type PreferencesContextValue,
} from "./PreferencesContext";

/** 导航/工作区域共享的内部通道（非公开契约）：路由持久化与偏好就绪信号。 */
export interface PreferencesRouteContextValue {
  /** 路由写入 preferences.lastRoute（last-write-wins），内存镜像同步更新。 */
  persistRoute(route: AppRoute): void;
  /** 路由/偏好异步写入状态：失败时为 "error"（R003 阶段 3，错误可观测）。 */
  routePersistenceStatus: "idle" | "error";
  /** 首次偏好加载结果（失败则拒绝），初始加载恢复路由前必须等待。 */
  whenLoaded: Promise<Preferences>;
}

const PreferencesRouteContext =
  createContext<PreferencesRouteContextValue | null>(null);

/** 读取内部路由通道；仅供 state 层内的 Provider 使用。 */
export function usePreferencesRoute(): PreferencesRouteContextValue {
  const ctx = useContext(PreferencesRouteContext);
  if (!ctx) {
    throw new Error("usePreferencesRoute 必须在 PreferencesProvider 内使用");
  }
  return ctx;
}

/** 偏好状态 Provider：挂载时加载偏好，卸载时 dispose 写入服务。 */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const services = useAppServices();
  // 偏好写入服务由装配根构造（R005 批次 2）：串行合并主题/侧栏宽度/AI 配置/
  // 路由更新，杜绝读-改-写竞态；非路由写入落盘后的 preferences-changed
  // 广播（R004 §7.2）也在装配根接线。
  const preferencesService = services.preferencesService;
  const [preferences, setPreferences] =
    useState<Preferences>(DEFAULT_PREFERENCES);
  // 路由持久化状态（R003 阶段 3）：偏好异步写入错误可观测。
  const [routePersistenceStatus, setRoutePersistenceStatus] = useState<
    "idle" | "error"
  >("idle");

  // 写入错误订阅：服务为容器单例，onError 日志在装配根，这里只置位状态。
  useEffect(() => {
    return preferencesService.subscribeErrors(() => {
      setRoutePersistenceStatus("error");
    });
  }, [preferencesService]);

  // 首次偏好加载：Promise 只创建一次，初始加载（路由恢复）经 whenLoaded
  // 等待同一份结果；写入内存镜像在 effect 中执行，卸载后不再 setState。
  const whenLoaded = useMemo(
    () => preferencesService.get(),
    [preferencesService],
  );
  useEffect(() => {
    let cancelled = false;
    whenLoaded.then(
      (prefs) => {
        if (!cancelled) setPreferences(prefs);
      },
      () => {
        // 加载失败由初始加载流程降级为错误页（whenLoaded 向上拒绝），此处只兜底。
      },
    );
    return () => {
      cancelled = true;
    };
  }, [whenLoaded]);

  // 卸载时 dispose：清侧栏防抖定时器并等待写入队列排空（R004 阶段 4）。
  // StrictMode「挂载 → 清理 → 再挂载」会触发一次 dispose，挂载时先 resume
  // 恢复同一实例（useMemo 不重建）的写入能力。
  useEffect(() => {
    preferencesService.resume();
    return () => {
      void preferencesService.dispose();
    };
  }, [preferencesService]);

  // 其他标签页改了偏好（主题/宽度/AI 配置，R004 §7.2）：重新加载内存镜像；
  // 自己发出的写入不回声（频道按来源 tabId 过滤），不会触发循环。
  useEffect(() => {
    return services.syncChannel.subscribe((event) => {
      if (event.type !== "preferences-changed") return;
      void preferencesService.get().then(setPreferences);
    });
  }, [services, preferencesService]);

  // 视图/页面切换时把路由写入 preferences，刷新后恢复到同一位置；
  // 经 PreferencesService 串行写入（last-write-wins），内存镜像同步更新。
  const persistRoute = useCallback(
    (route: AppRoute) => {
      const lastRoute = serializeRoute(route);
      preferencesService.persistRoute(lastRoute);
      setPreferences((prev) => ({ ...prev, lastRoute }));
    },
    [preferencesService],
  );

  // 偏好更新统一走 PreferencesService 串行队列（R003 阶段 3）：
  // update 返回合并后的完整偏好，直接整体替换内存镜像。
  const setTheme = useCallback(
    async (theme: Preferences["theme"]) => {
      const next = await preferencesService.update({ theme });
      setPreferences(next);
    },
    [preferencesService],
  );

  const setSidebarWidth = useCallback(
    async (width: number) => {
      // 拖动期间内存实时更新，持久化经服务 250ms 防抖（只落盘最后一次）。
      setPreferences((prev) => ({ ...prev, sidebarWidth: width }));
      preferencesService.updateSidebarWidthDebounced(width);
    },
    [preferencesService],
  );

  const setAIConfig = useCallback(
    async (config: AIConfig | null) => {
      // R005 阶段 8 §8.2：apiKey 入 SecretStore、endpoint/model 入偏好，
      // 编排由容器的 AIConfigService 承载（串行队列与广播语义不变）。
      const next =
        config === null
          ? await services.aiConfigService.clear()
          : await services.aiConfigService.save(config);
      setPreferences(next);
    },
    [services],
  );

  const value = useMemo<PreferencesContextValue>(
    () => ({
      preferences,
      setTheme,
      setSidebarWidth,
      setAIConfig,
    }),
    [preferences, setTheme, setSidebarWidth, setAIConfig],
  );

  const routeValue = useMemo<PreferencesRouteContextValue>(
    () => ({ persistRoute, routePersistenceStatus, whenLoaded }),
    [persistRoute, routePersistenceStatus, whenLoaded],
  );

  return (
    <PreferencesRouteContext.Provider value={routeValue}>
      <PreferencesContext.Provider value={value}>
        {children}
      </PreferencesContext.Provider>
    </PreferencesRouteContext.Provider>
  );
}
