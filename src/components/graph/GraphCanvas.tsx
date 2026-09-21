/**
 * R015.1：图谱 SVG 画布——平移 / 缩放 / 适应窗口 / 键盘导航。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { GraphProjection } from "../../application/graph/GraphQueryPort";
import type { GraphLayout, LaidOutNode } from "./layout";

interface GraphCanvasProps {
  projection: GraphProjection;
  layout: GraphLayout;
  selectedId: string | null;
  searchQuery?: string;
  ariaLabel: string;
  onSelect(id: string): void;
  onOpen(id: string): void;
  onBroken?(href: string, sourceId: string): void;
  onEscape?(): void;
}

export function GraphCanvas({
  projection,
  layout,
  selectedId,
  searchQuery,
  ariaLabel,
  onSelect,
  onOpen,
  onBroken,
  onEscape,
}: GraphCanvasProps) {
  const [view, setView] = useState({
    x: 0,
    y: 0,
    scale: 1,
  });
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const needle = searchQuery?.trim().toLowerCase() ?? "";

  const fit = useCallback(() => {
    setView({ x: 0, y: 0, scale: 1 });
  }, []);

  useEffect(() => {
    fit();
  }, [projection.centerNodeId, projection.nodes.length, fit]);

  useEffect(() => {
    if (!needle) return;
    const match = layout.nodes.find((n) =>
      n.title.toLowerCase().includes(needle),
    );
    if (!match) return;
    setView({
      x: layout.width / 2 - match.x,
      y: layout.height / 2 - match.y,
      scale: 1.2,
    });
    onSelect(match.id);
  }, [needle, layout, onSelect]);

  const transform = `translate(${view.x} ${view.y}) scale(${view.scale})`;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onNativeWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? 0.9 : 1.1;
      setView((prev) => ({
        ...prev,
        scale: Math.min(2.4, Math.max(0.4, prev.scale * factor)),
      }));
    };
    svg.addEventListener("wheel", onNativeWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onNativeWheel);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (
      event.target !== svgRef.current &&
      (event.target as Element).tagName !== "svg"
    ) {
      return;
    }
    dragRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.x;
    const dy = event.clientY - dragRef.current.y;
    dragRef.current = { x: event.clientX, y: event.clientY };
    setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const nodes = layout.nodes;

  const panTo = useCallback(
    (node: LaidOutNode) => {
      setView({
        x: layout.width / 2 - node.x,
        y: layout.height / 2 - node.y,
        scale: Math.max(view.scale, 1.1),
      });
    },
    [layout.height, layout.width, view.scale],
  );

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      onEscape?.();
      return;
    }
    if (event.key === "Enter" && selectedId) {
      event.preventDefault();
      onOpen(selectedId);
      return;
    }
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const ids = nodes.map((n) => n.id);
    if (ids.length === 0) return;
    const index = selectedId ? ids.indexOf(selectedId) : -1;
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = ids[(index + delta + ids.length) % ids.length]!;
    onSelect(next);
  };

  return (
    <div className="graph-canvas">
      <div className="graph-canvas__toolbar">
        <button type="button" onClick={fit} aria-label="适应窗口">
          适应窗口
        </button>
        <span className="graph-canvas__hint">
          滚轮缩放 · 拖动画布 · 方向键选择 · Enter 打开
        </span>
      </div>
      <svg
        ref={svgRef}
        className="graph-canvas__svg"
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <g transform={transform}>
          {layout.edges.map((edge) => (
            <g key={edge.id}>
              <line
                className={`graph-edge${edge.broken ? " graph-edge--broken" : ""}`}
                x1={edge.x1}
                y1={edge.y1}
                x2={edge.x2}
                y2={edge.y2}
              />
              {edge.broken ? (
                <circle
                  className="graph-edge__broken-hit"
                  cx={edge.x2}
                  cy={edge.y2}
                  r={10}
                  role="button"
                  tabIndex={0}
                  aria-label={`失效链接 ${edge.href}`}
                  onClick={() => onBroken?.(edge.href, edge.sourceId)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    onBroken?.(edge.href, edge.sourceId);
                  }}
                />
              ) : null}
            </g>
          ))}
          {nodes.map((node) => (
            <GraphNodeMark
              key={node.id}
              node={node}
              selected={selectedId === node.id}
              highlighted={Boolean(
                needle && node.title.toLowerCase().includes(needle),
              )}
              onSelect={() => onSelect(node.id)}
              onOpen={() => onOpen(node.id)}
              onCenter={() => {
                onSelect(node.id);
                panTo(node);
              }}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

function GraphNodeMark({
  node,
  selected,
  highlighted,
  onSelect,
  onOpen,
  onCenter,
}: {
  node: LaidOutNode;
  selected: boolean;
  highlighted: boolean;
  onSelect(): void;
  onOpen(): void;
  onCenter(): void;
}) {
  const className = [
    "graph-node",
    `graph-node--${node.role}`,
    selected ? "graph-node--selected" : "",
    highlighted ? "graph-node--hit" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <g
      className={className}
      data-graph-role={node.role}
      transform={`translate(${node.x} ${node.y})`}
      role="button"
      tabIndex={-1}
      aria-label={node.title}
      aria-current={selected ? "true" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        // 单击即选中并打开（G72 验收约定）；键盘路径为方向键选择 + Enter。
        onSelect();
        onOpen();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onCenter();
      }}
    >
      <circle r={node.role === "center" ? 16 : 12} />
      <text y={28} textAnchor="middle">
        {node.title}
      </text>
    </g>
  );
}
