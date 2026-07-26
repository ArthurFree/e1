/**
 * 浮层状态域（R003 阶段 6）：设置 / 搜索 / 回收站面板与窄屏文档树抽屉
 * 的开关。自包含 Provider——不依赖其他状态域，嵌在 AppProvider 分发树
 * 最内层；消除了原先 onOpenTree 的 prop drilling。
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** 浮层域暴露给组件的状态与动作。 */
export interface OverlayContextValue {
  settingsOpen: boolean;
  searchOpen: boolean;
  trashOpen: boolean;
  /** 窄屏抽屉式文档树。 */
  treeDrawerOpen: boolean;
  openSettings(): void;
  closeSettings(): void;
  openSearch(): void;
  closeSearch(): void;
  openTrash(): void;
  closeTrash(): void;
  openTreeDrawer(): void;
  closeTreeDrawer(): void;
}

const OverlayContext = createContext<OverlayContextValue | null>(null);

/** 浮层状态 Provider：四个开关各自独立 useState，value 统一 memo。 */
export function OverlayProvider({ children }: { children: ReactNode }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [treeDrawerOpen, setTreeDrawerOpen] = useState(false);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const openTrash = useCallback(() => setTrashOpen(true), []);
  const closeTrash = useCallback(() => setTrashOpen(false), []);
  const openTreeDrawer = useCallback(() => setTreeDrawerOpen(true), []);
  const closeTreeDrawer = useCallback(() => setTreeDrawerOpen(false), []);

  const value = useMemo<OverlayContextValue>(
    () => ({
      settingsOpen,
      searchOpen,
      trashOpen,
      treeDrawerOpen,
      openSettings,
      closeSettings,
      openSearch,
      closeSearch,
      openTrash,
      closeTrash,
      openTreeDrawer,
      closeTreeDrawer,
    }),
    [
      settingsOpen,
      searchOpen,
      trashOpen,
      treeDrawerOpen,
      openSettings,
      closeSettings,
      openSearch,
      closeSearch,
      openTrash,
      closeTrash,
      openTreeDrawer,
      closeTreeDrawer,
    ],
  );

  return (
    <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>
  );
}

/** 读取浮层域；在 OverlayProvider 外调用直接抛错。 */
export function useOverlay(): OverlayContextValue {
  const ctx = useContext(OverlayContext);
  if (!ctx) throw new Error("useOverlay 必须在 OverlayProvider 内使用");
  return ctx;
}
