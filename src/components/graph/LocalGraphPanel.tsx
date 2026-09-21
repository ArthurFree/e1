/**
 * R015.1：当前文档 Local Graph（空间关系 + depth 1|2）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphProjection } from "../../application/graph/GraphQueryPort";
import { useAppServices } from "../../state/AppServicesProvider";
import { useNavigationCommands } from "../../state/NavigationContext";
import { PagePicker } from "../PagePicker";
import { GraphCanvas } from "./GraphCanvas";
import { layoutLocalGraph } from "./layout";

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
  const invalidation = services.graphInvalidation;
  const { openDocument } = useNavigationCommands();
  const [depth, setDepth] = useState<1 | 2>(1);
  const [projection, setProjection] = useState<GraphProjection | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(pageId);
  const [brokenHref, setBrokenHref] = useState<{
    href: string;
    sourceId: string;
  } | null>(null);
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

  useEffect(() => {
    if (!invalidation) return;
    return invalidation.subscribe(() => {
      void refresh();
    });
  }, [invalidation, refresh]);

  const layout = useMemo(
    () => (projection ? layoutLocalGraph(projection) : null),
    [projection],
  );

  if (!graph) return null;

  return (
    <section className="local-graph" aria-label="当前文档关系">
      <header className="local-graph__header">
        <h2 className="local-graph__title">关系</h2>
        <label className="local-graph__depth">
          深度
          <select
            aria-label="关系深度"
            value={depth}
            onChange={(event) => setDepth(event.target.value === "2" ? 2 : 1)}
          >
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </label>
      </header>
      {projection?.truncated ? (
        <p className="local-graph__hint">关系较多，已截断显示。</p>
      ) : null}
      {layout && projection ? (
        <GraphCanvas
          projection={projection}
          layout={layout}
          selectedId={selectedId ?? pageId}
          ariaLabel="当前文档关系图"
          onSelect={setSelectedId}
          onOpen={(id) => void openDocument(id)}
          onBroken={(href, sourceId) => setBrokenHref({ href, sourceId })}
        />
      ) : (
        <p className="local-graph__empty">暂无关系</p>
      )}
      {brokenHref ? (
        <PagePicker
          excludePageId={brokenHref.sourceId}
          onClose={() => setBrokenHref(null)}
          onSelect={(targetId) => {
            const pending = brokenHref;
            setBrokenHref(null);
            void services.commands.document
              .relocateBrokenLink({
                sourcePageId: pending.sourceId,
                oldHref: pending.href,
                newTargetPageId: targetId,
              })
              .then(() => refresh())
              .catch(() => undefined);
          }}
        />
      ) : null}
    </section>
  );
}
