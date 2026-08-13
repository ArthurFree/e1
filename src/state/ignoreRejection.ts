/**
 * 忽略 Promise rejection（fire-and-forget 打点等不得干扰导航的路径）。
 * 调用方仍可用 .then 处理成功侧；失败一律吞掉。
 */
export function ignoreRejection(promise: Promise<unknown>): void {
  void promise.catch(() => {});
}
