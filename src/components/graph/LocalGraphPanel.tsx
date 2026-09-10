/**
 * R015：当前文档 Local Graph。门控 services.graph；失败静默，不影响保存。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { GraphProjection } from "../../application/graph/GraphQueryPort";
import { useAppServices } from "../../state/AppServicesProvider";
import { useNavigationCommands } from "../../state/NavigationContext";

interface LocalGraphPanelProps {
  pageId: string;
  vaultId: string;
  savedAt: number | null;
}

const REFRESH_DELAY_MS = 400;

export function LocalGraphPanel({
  pageId,
  vaultId,
  savedAt,
}: LocalGraphPanelProps) {
  const services = useAppServices();
  const graph = services.graph;
  const { openDocument } = useNavigationCommands();
  const [depth, setDepth] = useState<1 | 2>(1);
  const [projection, setProjection] = useState<GraphProjection | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!graph) return;
    const requestId = ++requestIdRef.current;
    try {
      const next = await graph.getLocalGraph({
        vaultId,
        pageId,
        depth,
        nodeLimit: 80,
        edgeLimit: 160,
        includeBroken: true,
      });
      if (requestId !== requestIdRef.current) return;
      setProjection(next);
    } catch {
      // GRAPH-04
    }
  }, [graph, vaultId, pageId, depth]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!savedAt) return;
    const timer = window.setTimeout(() => void refresh(), REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [savedAt, refresh]);

  if (!graph) return null;

  const outgoing = (projection?.edges ?? []).filter(
    (e) => e.sourceId === pageId,
  );
  const incoming = (projection?.edges ?? []).filter(
    (e) => e.targetId === pageId,
  );
  const titleOf = (id: string | null) =>
    projection?.nodes.find((n) => n.id === id)?.title ?? id ?? "未知";

  return (
    <section className="local-graph" aria-label="当前文档关系">
      <header className="local-graph__header">
        <h2 className="local-graph__title">关系</h2>
        <label className="local-graph__depth">
          深度
          <select
            aria-label="关系深度"
            value={depth}
            onChange={(event) =>
              setDepth(event.target.value === "2" ? 2 : 1)
            }
          >
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </label>
      </header>
      {projection?.truncated ? (
        <p className="local-graph__hint">关系较多，已截断显示。</p>
      ) : null}
      <div className="local-graph__center">{titleOf(pageId)}</div>
      <div className="local-graph__columns">
        <div>
          <h3 className="local-graph__heading">引用此页面</h3>
          {incoming.length === 0 ? (
            <p className="local-graph__empty">暂无反向链接</p>
          ) : (
            <ul className="local-graph__list">
              {incoming.map((edge) => (
                <li key={edge.id}>
                  <button
                    type="button"
                    className="local-graph__node"
                    onClick={() => void openDocument(edge.sourceId)}
                  >
                    {titleOf(edge.sourceId)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="local-graph__heading">此页面引用</h3>
          {outgoing.length === 0 ? (
            <p className="local-graph__empty">暂无出站链接</p>
          ) : (
            <ul className="local-graph__list">
              {outgoing.map((edge) =>
                edge.state === "broken" || !edge.targetId ? (
                  <li key={edge.id}>
                    <span className="local-graph__broken">
                      失效：{edge.href}
                    </span>
                  </li>
                ) : (
                  <li key={edge.id}>
                    <button
                      type="button"
                      className="local-graph__node"
                      onClick={() => void openDocument(edge.targetId!)}
                    >
                      {titleOf(edge.targetId)}
                    </button>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
