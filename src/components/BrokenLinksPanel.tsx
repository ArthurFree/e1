/**
 * @file 失效链接面板（R010 Stage 6 §14）：知识库级 broken 链接列表
 *（来源文档 → 原 href → 目标不存在），每行提供「重新定位」——经
 * PagePicker 选择新目标页面后调 commands.document.relocateBrokenLink
 * 编排落盘，成功后刷新列表。
 *
 * 门控（DUAL-01）：仅当 AppServices 装配了 linkIndex（Desktop）时可用；
 * Web 缺省 undefined，入口（WorkspaceHome「失效链接」按钮）与本面板
 * 都不出现。
 *
 * 刷新策略（与 DocumentLinksPanel 同口径：派生数据、允许秒级滞后）：
 * - 打开面板：prepare（幂等）+ 立即拉取；building 期间 500ms 轮询至就绪；
 * - 重新定位成功：先乐观移除命中行（自写 upsert 经 reconciler 异步落库），
 *   400ms 后再拉一次对齐索引真实状态；
 * - 慢查询后至经 requestId 丢弃过期结果（SearchPanel §14.3 同口径）。
 *
 * 已知边界：internalLink/mention 节点引用（href 为 ""）无法确定性定位
 * 到具体节点，「重新定位」禁用（编排层同口径拒绝，见
 * DocumentCommandService.relocateBrokenLink 头注）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentLink } from "../application/links/LinkIndex";
import type { SearchIndexStatus } from "../application/search/SearchIndexStatus";
import { useAppServices } from "../state/AppServicesProvider";
import { useWorkspaceData } from "../state/WorkspaceSessionContext";
import { useNavigationCommands } from "../state/NavigationContext";
import { Dialog } from "./ui/Dialog";
import { EmptyState } from "./ui/EmptyState";
import { PageIcon } from "./ui/icons";
import { PagePicker } from "./PagePicker";

interface BrokenLinksPanelProps {
  /** 当前知识库 id（Desktop 即 vaultId）。 */
  vaultId: string;
  /** 关闭面板（Escape、点击遮罩时触发）。 */
  onClose(): void;
}

/** 重新定位成功后等待 reconciler upsert 落库的延迟（ms，面板同口径）。 */
const REFRESH_DELAY_MS = 400;
/** 索引 building 期间的状态轮询间隔（ms，SearchPanel 先例）。 */
const BUILDING_POLL_MS = 500;

/** 失效链接面板：知识库内全部 broken 链接的列表与逐条重新定位。 */
export function BrokenLinksPanel({ vaultId, onClose }: BrokenLinksPanelProps) {
  const services = useAppServices();
  const linkIndex = services.linkIndex;
  const { pages } = useWorkspaceData();
  const { openDocument } = useNavigationCommands();
  const [links, setLinks] = useState<DocumentLink[] | null>(null);
  const [status, setStatus] = useState<SearchIndexStatus | null>(null);
  /** 重新定位失败的错误文案（DomainError message 即用户文案）。 */
  const [error, setError] = useState<string | null>(null);
  /** 正在选择新目标的链接（打开 PagePicker）。 */
  const [pickerFor, setPickerFor] = useState<DocumentLink | null>(null);
  /** 正在进行落盘的行（禁用按钮防重入）。 */
  const [relocatingKey, setRelocatingKey] = useState<string | null>(null);
  // §14.3 同口径：慢查询后至时丢弃过期结果。
  const requestIdRef = useRef(0);
  // PagePicker 是否打开（供稳定引用的 guardedClose 读取，见下方注释）。
  const pickerOpenRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!linkIndex) return;
    const requestId = ++requestIdRef.current;
    setStatus(linkIndex.getStatus(vaultId));
    try {
      const broken = await linkIndex.getBrokenLinks(vaultId);
      if (requestId !== requestIdRef.current) return;
      setLinks(broken);
    } catch {
      // LINK-03：索引是派生数据，读取失败静默降级为空白列表。
    }
  }, [linkIndex, vaultId]);

  // 打开面板：立即拉取 + 确保索引存在；building 期间轮询至就绪。
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

  const relocate = async (link: DocumentLink, newTargetPageId: string) => {
    const key = `${link.sourcePageId}${link.href}`;
    setRelocatingKey(key);
    setError(null);
    try {
      await services.commands.document.relocateBrokenLink({
        sourcePageId: link.sourcePageId,
        oldHref: link.href,
        newTargetPageId,
      });
      // 乐观移除命中行；reconciler 的自写 upsert 异步落库，
      // 延迟后再拉一次对齐索引真实状态。
      setLinks(
        (prev) =>
          prev?.filter(
            (item) =>
              !(
                item.sourcePageId === link.sourcePageId &&
                item.href === link.href
              ),
          ) ?? null,
      );
      setTimeout(() => void refresh(), REFRESH_DELAY_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新定位失败，请重试。");
    } finally {
      setRelocatingKey(null);
    }
  };

  // PagePicker（嵌套 Dialog）打开时屏蔽外层面板的 Escape/遮罩关闭，
  // 否则一次 Escape 会同时关掉两层（Dialog 的 Escape 监听在 document 上）。
  // 经 ref 读取保持回调引用稳定——Dialog 的聚焦/Escape 副作用以 onClose
  // 为依赖，每次渲染换引用会导致外层 Dialog 重聚焦、抢走 PagePicker 焦点。
  pickerOpenRef.current = pickerFor !== null;
  const guardedClose = useCallback(() => {
    if (!pickerOpenRef.current) onClose();
  }, [onClose]);

  if (!linkIndex) return null;

  const rows = links ?? [];
  const showBuilding = status?.state === "building";
  return (
    <Dialog label="失效链接" className="trash-panel" onClose={guardedClose}>
      <div className="dialog__header">
        <span>失效链接{rows.length > 0 ? ` · ${rows.length}` : ""}</span>
      </div>
      {error && (
        <div className="broken-links__error" role="alert">
          {error}
        </div>
      )}
      {showBuilding ? (
        <div className="dialog__empty" role="status">
          正在建立链接索引…
        </div>
      ) : links === null ? (
        <div className="dialog__empty">正在加载…</div>
      ) : rows.length === 0 ? (
        <EmptyState title="没有失效链接。" />
      ) : (
        <div className="trash-panel__list">
          {rows.map((link, index) => {
            const key = `${link.sourcePageId}${link.href}`;
            const source = pages.find((p) => p.id === link.sourcePageId);
            const sourceTitle = source?.title || "未知文档";
            // 节点引用（@ 提及）href 恒为 ""，无法确定性匹配，禁用入口。
            const relocatable = link.href.trim() !== "";
            return (
              <div key={`${key}:${index}`} className="broken-links__row">
                <button
                  type="button"
                  className="broken-links__source"
                  title="打开来源文档"
                  onClick={() => {
                    void openDocument(link.sourcePageId);
                    onClose();
                  }}
                >
                  <PageIcon icon={source?.icon} kind="document" size={14} />
                  <span className="broken-links__source-title">
                    {sourceTitle}
                  </span>
                </button>
                <span
                  className="broken-links__href"
                  title={link.href || "（页面引用）"}
                >
                  {link.href || link.label || "（页面引用）"}
                </span>
                <span className="broken-links__tag">目标不存在</span>
                <button
                  type="button"
                  className="broken-links__relocate"
                  disabled={!relocatable || relocatingKey === key}
                  title={
                    relocatable
                      ? "选择新的目标页面"
                      : "页面引用暂不支持重新定位"
                  }
                  onClick={() => setPickerFor(link)}
                >
                  {relocatingKey === key ? "正在保存…" : "重新定位"}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {pickerFor && (
        <PagePicker
          excludePageId={pickerFor.sourcePageId}
          onClose={() => setPickerFor(null)}
          onSelect={(pageId) => {
            const target = pickerFor;
            setPickerFor(null);
            void relocate(target, pageId);
          }}
        />
      )}
    </Dialog>
  );
}
