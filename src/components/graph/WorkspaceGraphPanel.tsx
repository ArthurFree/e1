/**
 * R015.1：Workspace Graph 对话框——有界 Canvas + 搜索 / Group / Tag / 孤立 / 失效边。
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { GraphProjection } from "../../application/graph/GraphQueryPort";
import { useAppServices } from "../../state/AppServicesProvider";
import { useNavigationCommands } from "../../state/NavigationContext";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { GraphCanvas } from "./GraphCanvas";
import { layoutWorkspaceGraph } from "./layout";

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
  const invalidation = services.graphInvalidation;
  const { openDocument } = useNavigationCommands();
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [groupPath, setGroupPath] = useState("");
  const [tag, setTag] = useState("");
  const [orphansOnly, setOrphansOnly] = useState(false);
  const [includeBroken, setIncludeBroken] = useState(true);
  const [projection, setProjection] = useState<GraphProjection | null>(null);
  const [facets, setFacets] = useState<{
    groups: string[];
    tags: string[];
  }>({ groups: [], tags: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!graph) return;
    try {
      const [next, catalog] = await Promise.all([
        graph.getWorkspaceGraph({
          vaultId,
          nodeLimit: 200,
          edgeLimit: 500,
          filters: {
            query: query.trim() || undefined,
            groupPath: groupPath || undefined,
            tag: tag || undefined,
            orphansOnly,
            includeBroken,
          },
        }),
        graph.getWorkspaceGraph({
          vaultId,
          nodeLimit: 200,
          edgeLimit: 500,
          filters: { includeBroken: true },
        }),
      ]);
      setProjection(next);
      setFacets({
        groups: [
          ...new Set(
            catalog.nodes
              .map((node) => node.groupPath)
              .filter((value): value is string => Boolean(value)),
          ),
        ].sort(),
        tags: [...new Set(catalog.nodes.flatMap((node) => node.tags))].sort(),
      });
    } catch {
      setProjection({ nodes: [], edges: [], truncated: false });
    }
  }, [graph, vaultId, query, groupPath, tag, orphansOnly, includeBroken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!invalidation) return;
    return invalidation.subscribe(() => {
      void refresh();
    });
  }, [invalidation, refresh]);

  const layout = useMemo(
    () => (projection ? layoutWorkspaceGraph(projection) : null),
    [projection],
  );

  if (!graph) return null;

  return (
    <Dialog
      label="知识图谱"
      onClose={onClose}
      className="workspace-graph-dialog"
    >
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
            分组
            <select
              aria-label="按分组筛选"
              value={groupPath}
              onChange={(event) => setGroupPath(event.target.value)}
            >
              <option value="">全部</option>
              {facets.groups.map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
          </label>
          <label>
            标签
            <select
              aria-label="按标签筛选"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
            >
              <option value="">全部</option>
              {facets.tags.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
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
            结果已截断，请使用搜索 / Group / Tag 缩小范围。
          </p>
        ) : null}
        {!projection || projection.nodes.length === 0 || !layout ? (
          <EmptyState title="没有可展示的文档关系" />
        ) : (
          <GraphCanvas
            projection={projection}
            layout={layout}
            selectedId={selectedId}
            searchQuery={query}
            ariaLabel="知识库关系图"
            onSelect={setSelectedId}
            onOpen={(id) => {
              void openDocument(id);
              onClose();
            }}
            onEscape={onClose}
          />
        )}
      </div>
    </Dialog>
  );
}
