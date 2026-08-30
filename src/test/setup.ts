import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { afterEach } from "vitest";
import { act } from "@testing-library/react";

// 全局收尾（R009 §3.2）：每个用例结束后排空 React 挂起的异步工作。
// React dev 构建在每次 commit 后以 NormalPriority 再调度一次 passive
// effects flush（回调内访问 window.event），走真实 Scheduler 的宏任务；
// 若该宏任务晚于 jsdom 环境销毁执行，会抛 unhandled
// "ReferenceError: window is not defined"。这里先用 act 排空 act 队列，
// 再让出一个宏任务，使真实调度器的回调在环境仍存活时执行完毕。
// setup 文件先于测试文件注册，afterEach 逆序执行，故本钩子在 RTL
// auto-cleanup（卸载组件）之后运行，可同时排空空卸载产生的调度回调。
afterEach(async () => {
  await act(async () => {});
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
});

// jsdom 未实现 Range.getClientRects / getBoundingClientRect，
// ProseMirror 的 scrollToSelection 会因此抛 TypeError（未捕获异常），
// 这里补空实现，仅影响 jsdom 下的坐标计算，不改变任何断言语义。
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}
