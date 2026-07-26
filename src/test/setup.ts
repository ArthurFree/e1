import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

// jsdom 未实现 Range.getClientRects / getBoundingClientRect，
// ProseMirror 的 scrollToSelection 会因此抛 TypeError（未捕获异常），
// 这里补空实现，仅影响 jsdom 下的坐标计算，不改变任何断言语义。
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
}
