/**
 * @file 文档链接面板（R010 Stage 5 §13）：当前文档的「引用此页面」
 *（backlinks）与「此页面引用」（outgoing links），渲染在正文下方、随
 * 文档滚动。
 *
 * 门控（DUAL-01）：仅当 AppServices 装配了 linkIndex（Desktop）时渲染；
 * Web 缺省 undefined，面板整体不出现。
 *
 * noteKey 口径：LinkIndex port 的入参是 Main 稳定键
 *（stableNoteId ?? "path:<relativePath>"），与会话页面 id 的派生规则
 *（pageIdOfEntry：Frontmatter noteId ?? "path:<rel>"）一致，故直接把
 * pageId 作为 noteKey 传给索引查询，不新造身份映射；同会话 Stable ID
 * Adoption（path:* 会话 id → 磁盘已有 Frontmatter id）的翻译由平台层
 * DesktopLinkIndex 经 Alias Registry 完成（R010 Stage 7），组件层不绕行。
 *
 * 刷新策略（取舍：简单可靠优先，链接面板是派生数据、允许秒级滞后）：
 * - 打开/切换文档：立即拉取一次，并 prepare 确保索引存在（幂等）；
 * - building 期间：500ms 轮询状态直至就绪（SearchPanel 先例），就绪后
 *   再拉一次；
 * - 自写保存（savedAt 变化）与外部变更（externalVaultChanges 同 vault
 *   批次）：400ms 防抖后拉取——reconciler 的 links.upsert 是异步
 *   best-effort，稍作延迟让索引先落库，避免拉到旧快照；
 * - 慢查询后至经 requestId 丢弃（SearchPanel §14.3 同口径）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Backlink, DocumentLink } from "../../application/links/LinkIndex";
import type { SearchIndexStatus } from "../../application/search/SearchIndexStatus";
import { useAppServices } from "../../state/AppServicesProvider";
import { useWorkspaceData } from "../../state/WorkspaceSessionContext";
import { useNavigationCommands } from "../../state/NavigationContext";

interface DocumentLinksPanelProps {
  /** 当前文档的会话页面 id（即索引 noteKey，见文件头口径说明）。 */
  pageId: string;
  /** 当前知识库 id（Desktop 即 vaultId）。 */
  vaultId: string;
  /** 最近一次成功保存的时间戳；变化即触发一次延迟刷新。 */
  savedAt: number | null;
}

/** 保存/外部事件后等待 reconciler upsert 落库的延迟（ms）。 */
const REFRESH_DELAY_MS = 400;
/** 索引 building 期间的状态轮询间隔（ms，SearchPanel 先例）。 */
const BUILDING_POLL_MS = 500;

/** 非 internal 链接的种类徽标文案。 */
const KIND_LABELS: Record<DocumentLink["kind"], string | null> = {
  internal: null,
  external: "外部链接",
  mailto: "邮件",
  asset: "附件",
  anchor: "页内锚点",
};

export function DocumentLinksPanel({
  pageId,
  vaultId,
  savedAt,
}: DocumentLinksPanelProps) {
  const services = useAppServices();
  const linkIndex = services.linkIndex;
  const { pages } = useWorkspaceData();
  const { openDocument } = useNavigationCommands();
  // 查询结果按「vaultId + pageId」归属存放：切换文档的同一次渲染内即
  // 失效，不把上一篇文档的链接带到新文档（useDocumentSession 同口径）。
  const [result, setResult] = useState<{
    key: string;
    backlinks: Backlink[];
    outgoing: DocumentLink[];
  } | null>(null);
  const [status, setStatus] = useState<SearchIndexStatus | null>(null);
  // §14.3 同口径：慢查询后至时丢弃过期结果（不回填旧列表）。
  const requestIdRef = useRef(0);
  const resultKey = `${vaultId}${pageId}`;

  const refresh = useCallback(async () => {
    if (!linkIndex) return;
    const requestId = ++requestIdRef.current;
    setStatus(linkIndex.getStatus(vaultId));
    try {
      const [backlinks, outgoing] = await Promise.all([
        linkIndex.getBacklinks({ vaultId, noteKey: pageId }),
        linkIndex.getOutgoing({ vaultId, noteKey: pageId }),
      ]);
      if (requestId !== requestIdRef.current) return;
      setResult({
        key: `${vaultId}${pageId}`,
        backlinks,
        outgoing,
      });
    } catch {
      // LINK-03：索引是派生数据，读取失败静默降级（不打扰编辑主流程）。
    }
  }, [linkIndex, vaultId, pageId]);

  // 打开/切换文档：立即拉取 + 确保索引存在；building 期间轮询至就绪。
  useEffect(() => {
    if (!linkIndex) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const initial = linkIndex.getStatus(vaultId);
    setStatus(initial);
    void refresh();
    void linkIndex
      .prepare(vaultId)
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        setStatus(linkIndex.getStatus(vaultId));
        void refresh();
      });
    if (initial.state === "building") {
      timer = setInterval(() => {
        if (cancelled) return;
        const next = linkIndex.getStatus(vaultId);
        setStatus(next);
        if (next.state !== "building" && timer) {
          clearInterval(timer);
          timer = null;
          void refresh();
        }
      }, BUILDING_POLL_MS);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [linkIndex, vaultId, refresh]);

  // 自写保存后延迟刷新：reconciler 的 links.upsert 异步落库，稍作等待。
  const prevSavedAtRef = useRef(savedAt);
  useEffect(() => {
    const changed = savedAt !== null && savedAt !== prevSavedAtRef.current;
    prevSavedAtRef.current = savedAt;
    if (!changed || !linkIndex) return;
    const timer = setTimeout(() => void refresh(), REFRESH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [savedAt, linkIndex, refresh]);

  // 外部变更（其他程序改动 Markdown → watcher → reconciler upsert）：
  // 同 vault 批次后防抖刷新（R010 §16 G26）。
  useEffect(() => {
    const external = services.externalVaultChanges;
    if (!linkIndex || !external) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = external.subscribe((changes) => {
      if (!changes.some((change) => change.vaultId === vaultId)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, REFRESH_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [services, linkIndex, vaultId, refresh]);

  if (!linkIndex) return null;

  const rebuild = () => {
    setStatus({ state: "building" });
    void linkIndex
      .rebuild(vaultId)
      .catch(() => undefined)
      .then(() => {
        setStatus(linkIndex.getStatus(vaultId));
        void refresh();
      });
  };

  const current = result?.key === resultKey ? result : null;
  const backlinks = current?.backlinks ?? [];
  const outgoing = current?.outgoing ?? [];
  const showBuilding = status?.state === "building";
  const showDegraded =
    status?.state === "degraded" || status?.state === "corrupt";
  // 两个列表都为空且无索引状态提示时整体隐藏，避免在普通文档底部留空区。
  if (
    !showBuilding &&
    !showDegraded &&
    backlinks.length === 0 &&
    outgoing.length === 0
  ) {
    return null;
  }

  const outgoingMeta = (link: DocumentLink): string | null => {
    // internal 链接的主体信息（label/目标标题）已足够，不再附 href。
    if (link.kind === "internal") return null;
    if (link.kind === "anchor") {
      return link.fragment ? `#${link.fragment}` : null;
    }
    return link.href || null;
  };

  return (
    <section className="doc-links" aria-label="页面链接">
      {showBuilding && (
        <div className="doc-links__hint" role="status">
          正在建立链接索引…
        </div>
      )}
      {showDegraded && (
        <div className="doc-links__hint" role="alert">
          <span>链接索引需要修复</span>
          <button type="button" onClick={rebuild}>
            重建索引
          </button>
        </div>
      )}
      {backlinks.length > 0 && (
        <div className="doc-links__section">
          <h2 className="doc-links__heading">
            引用此页面 · {backlinks.length}
          </h2>
          <ul className="doc-links__list">
            {backlinks.map((link, index) => (
              <li key={`${link.sourcePageId}:${link.href}:${index}`}>
                <button
                  type="button"
                  className="doc-links__backlink"
                  onClick={() => void openDocument(link.sourcePageId)}
                >
                  <span className="doc-links__title">
                    {link.sourceTitle || "无标题"}
                  </span>
                  {link.snippet && (
                    <span className="doc-links__snippet">
                      「{link.snippet}」
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {outgoing.length > 0 && (
        <div className="doc-links__section">
          <h2 className="doc-links__heading">此页面引用 · {outgoing.length}</h2>
          <ul className="doc-links__list">
            {outgoing.map((link, index) => {
              const targetTitle = link.targetPageId
                ? (pages.find((p) => p.id === link.targetPageId)?.title ?? null)
                : null;
              const label = link.label || targetTitle || link.href || "链接";
              const kindLabel = KIND_LABELS[link.kind];
              const meta = outgoingMeta(link);
              const inner = (
                <>
                  <span className="doc-links__title">{label}</span>
                  {link.broken && (
                    <span className="doc-links__tag">目标不存在</span>
                  )}
                  {!link.broken && kindLabel && (
                    <span className="doc-links__tag">{kindLabel}</span>
                  )}
                  {meta && <span className="doc-links__meta">{meta}</span>}
                </>
              );
              const clickable =
                link.kind === "internal" && !link.broken && link.targetPageId;
              return (
                <li key={`${link.href}:${link.label}:${index}`}>
                  {clickable ? (
                    <button
                      type="button"
                      className="doc-links__item"
                      onClick={() =>
                        void openDocument(link.targetPageId as string)
                      }
                    >
                      {inner}
                    </button>
                  ) : (
                    <div
                      className={`doc-links__item${
                        link.broken ? " doc-links__item--broken" : ""
                      }`}
                    >
                      {inner}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
