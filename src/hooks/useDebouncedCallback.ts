import { useCallback, useEffect, useRef } from "react";

/**
 * 防抖回调：delay 内的连续调用只执行最后一次。
 * flush() 立即执行挂起的调用（用于页面切换/卸载前强制落盘）。
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
  const pendingRef = useRef<Args | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
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
        if (pendingRef.current !== null) {
          const pending = pendingRef.current;
          pendingRef.current = null;
          fnRef.current(...pending);
        }
      }, delay);
    },
    [delay],
  );

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
