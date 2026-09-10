/**
 * R015：Workspace Graph 对话框。有界投影 + 搜索/孤立页筛选。
 */
import { useCallback, useEffect, useId, useState } from "react";
import type { GraphProjection } from "../../application/graph/GraphQueryPort";
import { useAppServices } from "../../state/AppServicesProvider";
import { useNavigationCommands } from "../../state/NavigationContext";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";

interface WorkspaceGraphPanelProps {
  vaultId: string;
  onClose(): void;
}

export function WorkspaceGraphPanel({
  vaultId,
  onClose,
}: WorkspaceGraphPanelProps) {
  const services = useAppServices();
  const graph = services.graph;
  const { openDocument } = useNavigationCommands();
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [orphansOnly, setOrphansOnly] = useState(false);
  const [includeBroken, setIncludeBroken] = useState(true);
  const [projection, setProjection] = useState<GraphProjection | null>(null);

  const refresh = useCallback(async () => {
    if (!graph) return;
    try {
      const next = await graph.getWorkspaceGraph({
        vaultId,
        nodeLimit: 200,
        edgeLimit: 500,
        filters: {
          query: query.trim() || undefined,
          orphansOnly,
          includeBroken,
        },
      });
      setProjection(next);
    } catch {
      setProjection({ nodes: [], edges: [], truncated: false });
    }
  }, [graph, vaultId, query, orphansOnly, includeBroken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!graph) return null;

  return (
    <Dialog label="知识图谱" onClose={onClose} className="workspace-graph-dialog">
      <div className="workspace-graph">
        <h2 id={titleId} className="workspace-graph__title">
          知识图谱
        </h2>
        <div className="workspace-graph__toolbar">
          <input
            type="search"
            aria-label="搜索文档"
            placeholder="搜索标题或路径"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={orphansOnly}
              onChange={(event) => setOrphansOnly(event.target.checked)}
            />
            仅孤立文档
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeBroken}
              onChange={(event) => setIncludeBroken(event.target.checked)}
            />
            含失效链接
          </label>
        </div>
        {projection?.truncated ? (
          <p className="workspace-graph__hint">
            结果已截断，请使用搜索或筛选缩小范围。
          </p>
        ) : null}
        {!projection || projection.nodes.length === 0 ? (
          <EmptyState title="没有可展示的文档关系" />
        ) : (
          <ul className="workspace-graph__list">
            {projection.nodes.map((node) => {
              const degree = projection.edges.filter(
                (e) => e.sourceId === node.id || e.targetId === node.id,
              ).length;
              return (
                <li key={node.id}>
                  <button
                    type="button"
                    className="workspace-graph__node"
                    onClick={() => {
                      void openDocument(node.id);
                      onClose();
                    }}
                  >
                    <span>{node.title}</span>
                    <span className="workspace-graph__meta">
                      {node.relativePath} · {degree} 条边
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
