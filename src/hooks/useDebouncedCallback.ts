import { useCallback, useEffect, useRef } from "react";

/**
 * 防抖回调：delay 内的连续调用只执行最后一次。
 * flush() 立即执行挂起的调用（用于页面切换/卸载前强制落盘）。
 *
 * 主要服务于编辑器防抖保存（DocumentEditor），落实「编辑器变更经防抖后保存，
 * 切换文档或卸载页面时强制落盘」的架构约束。
 *
 * @param fn 被防抖的回调；每次渲染提交后同步到 ref，定时器里执行的始终是最新闭包。
 * @param delay 防抖间隔（毫秒）。
 * @returns debounced 为防抖后的调用入口；flush 立即执行挂起调用，
 *   无挂起调用时为空操作，可安全重复调用。
 *
 * 边界与竞态：
 * - 组件卸载与 beforeunload（页面刷新/关闭）时自动 flush，避免最后一次修改丢失；
 * - flush 与定时器回调都先取走挂起参数再执行 fn，fn 内若同步重入 debounced，
 *   不会覆盖或污染本轮调用。
 */
export function useDebouncedCallback<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay: number,
) {
  const fnRef = useRef(fn);
  // 渲染期不写 ref（React 可重放/丢弃渲染），提交后在 effect 中同步。
  useEffect(() => {
    fnRef.current = fn;
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 挂起参数与计时器分开存放：flush 需要在定时器未触发时也能取到参数。
  const pendingRef = useRef<Args | null>(null);

  const flush = useCallback(() => {
    // 先停表再执行，避免 flush 后定时器又触发一次重复调用。
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // 先取走参数再调 fn：fn 内若同步重入 debounced，从干净状态开始。
    if (pendingRef.current !== null) {
      const args = pendingRef.current;
      pendingRef.current = null;
      fnRef.current(...args);
    }
  }, []);

  const debounced = useCallback(
    (...args: Args) => {
      pendingRef.current = args;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        // 与 flush 相同：先清状态再执行，保证重入安全。
        if (pendingRef.current !== null) {
          const pending = pendingRef.current;
          pendingRef.current = null;
          fnRef.current(...pending);
        }
      }, delay);
    },
    [delay],
  );

  // 强制落盘兜底：beforeunload 覆盖刷新/关闭页面，cleanup 覆盖组件卸载（如切换文档）。
  useEffect(() => {
    const onUnload = () => flush();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      flush();
    };
  }, [flush]);

  return { debounced, flush };
}
