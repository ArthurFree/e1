/**
 * GraphCanvas 组件测试（R015.1）：
 * 方向键循环选择节点、Enter 打开、Escape 关闭、失效边键盘可达
 * （Tab 聚焦 + Enter/Space 触发 onBroken 且不冒泡成 onOpen）、
 * 静态键盘提示渲染；布局用 layout.ts 真实输出。
 */
import type { ReactNode } from "react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GraphProjection } from "../../application/graph/GraphQueryPort";
import { GraphCanvas } from "./GraphCanvas";
import { layoutLocalGraph } from "./layout";

function makeProjection(): GraphProjection {
  return {
    centerNodeId: "a",
    nodes: [
      {
        id: "a",
        title: "中心页",
        relativePath: "中心.md",
        groupPath: null,
        tags: [],
      },
      {
        id: "b",
        title: "出站页",
        relativePath: "出站.md",
        groupPath: null,
        tags: [],
      },
      {
        id: "c",
        title: "来源页",
        relativePath: "来源.md",
        groupPath: null,
        tags: [],
      },
    ],
    edges: [
      {
        id: "e1",
        sourceId: "a",
        targetId: "b",
        direction: "outgoing",
        state: "resolved",
        href: "出站.md",
      },
      {
        id: "e2",
        sourceId: "c",
        targetId: "a",
        direction: "outgoing",
        state: "resolved",
        href: "中心.md",
      },
      {
        id: "e3",
        sourceId: "a",
        targetId: null,
        direction: "outgoing",
        state: "broken",
        href: "缺失.md",
      },
    ],
    truncated: false,
  };
}

/** 受控 selectedId 容器：模拟父组件持有选中态，验证循环选择。 */
function Harness({
  onSelect,
  onOpen,
  onEscape,
  onBroken,
}: {
  onSelect(id: string): void;
  onOpen(id: string): void;
  onEscape?(): void;
  onBroken?(href: string, sourceId: string): void;
}): ReactNode {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const projection = makeProjection();
  return (
    <GraphCanvas
      projection={projection}
      layout={layoutLocalGraph(projection)}
      selectedId={selectedId}
      ariaLabel="当前文档关系图"
      onSelect={(id) => {
        setSelectedId(id);
        onSelect(id);
      }}
      onOpen={onOpen}
      onEscape={onEscape}
      onBroken={onBroken}
    />
  );
}

describe("GraphCanvas", () => {
  afterEach(() => {
    cleanup();
  });

  it("渲染静态键盘操作提示", () => {
    render(<Harness onSelect={() => {}} onOpen={() => {}} />);
    expect(
      screen.getByText("滚轮缩放 · 拖动画布 · 方向键选择 · Enter 打开"),
    ).toBeInTheDocument();
  });

  it("方向键循环选择节点（布局顺序：中心 → 入边 → 出边）", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} onOpen={() => {}} />);
    const svg = screen.getByRole("img", { name: "当前文档关系图" });

    // 未选中时 ArrowRight 选中第一个（center a）；布局顺序为 a → c → b。
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("a");
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("b");
    // 越界循环回第一个。
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("a");
    // ArrowLeft 反向循环。
    fireEvent.keyDown(svg, { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith("b");
  });

  it("Enter 触发 onOpen（当前选中节点）", () => {
    const onOpen = vi.fn();
    render(<Harness onSelect={() => {}} onOpen={onOpen} />);
    const svg = screen.getByRole("img", { name: "当前文档关系图" });

    // 未选中时 Enter 不打开。
    fireEvent.keyDown(svg, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.keyDown(svg, { key: "ArrowRight" });
    fireEvent.keyDown(svg, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("Escape 触发 onEscape", () => {
    const onEscape = vi.fn();
    render(
      <Harness onSelect={() => {}} onOpen={() => {}} onEscape={onEscape} />,
    );
    fireEvent.keyDown(screen.getByRole("img", { name: "当前文档关系图" }), {
      key: "Escape",
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("失效边可聚焦（tabIndex 0），Enter/Space 触发 onBroken", () => {
    const onBroken = vi.fn();
    render(
      <Harness onSelect={() => {}} onOpen={() => {}} onBroken={onBroken} />,
    );
    const hit = screen.getByRole("button", { name: "失效链接 缺失.md" });
    expect(hit).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(hit, { key: "Enter" });
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(onBroken).toHaveBeenLastCalledWith("缺失.md", "a");

    fireEvent.keyDown(hit, { key: " " });
    expect(onBroken).toHaveBeenCalledTimes(2);

    // 既有鼠标点击行为不变。
    fireEvent.click(hit);
    expect(onBroken).toHaveBeenCalledTimes(3);
    expect(onBroken).toHaveBeenLastCalledWith("缺失.md", "a");
  });

  it("失效边上的 Enter 不冒泡成 svg 的 onOpen", () => {
    const onOpen = vi.fn();
    const onBroken = vi.fn();
    render(<Harness onSelect={() => {}} onOpen={onOpen} onBroken={onBroken} />);
    const svg = screen.getByRole("img", { name: "当前文档关系图" });
    // 先选中节点 a，再对失效边按 Enter：只触发 onBroken。
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    fireEvent.keyDown(
      screen.getByRole("button", { name: "失效链接 缺失.md" }),
      {
        key: "Enter",
      },
    );
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
