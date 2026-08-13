/**
 * @file 文档打开状态 hook（R006-C3 FR-17/19/20 + R006-C4，自 MainArea 提取）。
 *
 * 访问级别 / 兼容性 / 写入策略全部由 useDocumentSession 的打开结果派生；
 * 用户的会话级决定（允许本次编辑 / 保持只读 / 详情弹层）以 sessionKey 归属，
 * 会话切换即自然失效——「允许本次编辑」只对当前 Document Session 生效，
 * 重新打开文档重新判断（§28.2）。
 */

import { useCallback, useState } from "react";
import type {
  DocumentAccess,
  DocumentOpenResult,
  DocumentWritePolicy,
} from "../../../application/queries/DocumentQueryService";
import { DEFAULT_WRITE_POLICY } from "../../../application/queries/documentWritePolicy";
import { useAppServices } from "../../../state/AppServicesProvider";

/** 兼容性默认值（无打开结果的新文档 / Web 恒兼容）。 */
const EMPTY_COMPATIBILITY: DocumentOpenResult["compatibility"] = {
  lossy: false,
  unsupported: [],
};

export interface DocumentCompatibility {
  access: DocumentAccess;
  /** 打开时检出的 Markdown 兼容性（lossy 标记与 unsupported 明细）。 */
  markdown: DocumentOpenResult["compatibility"];
  writePolicy: DocumentWritePolicy;
  /** Stable ID Adoption 提示条是否可见（C4-F：选「保持只读」后隐藏）。 */
  identityAdoptionVisible: boolean;
  detailOpen: boolean;
  openDetail(): void;
  closeDetail(): void;
  /** C4-F「保持只读」：隐藏 Adoption 提示，仍不可编辑。 */
  keepReadOnly(): void;
  /** C4-F「启用编辑」：批准 Adoption 会话授权并转为可编辑。 */
  allowIdentityAdoption(): void;
  /** FR-20「允许本次编辑」：批准有损来源会话授权并转为可编辑。 */
  allowLossyEditing(): void;
  /** C4「仍然保存」：批准有损输出保存的会话授权（重试保存由调用方触发）。 */
  approveLossyOutput(): void;
}

export function useDocumentCompatibility(input: {
  pageId: string | null;
  sessionKey: string;
  opened: DocumentOpenResult | null;
}): DocumentCompatibility {
  const { pageId, sessionKey, opened } = input;
  const services = useAppServices();
  // 三个会话级决定各存「归属的 sessionKey」：与当前会话不一致即视为未做过。
  const [editingAllowedFor, setEditingAllowedFor] = useState<string | null>(
    null,
  );
  const [keptReadOnlyFor, setKeptReadOnlyFor] = useState<string | null>(null);
  const [detailOpenFor, setDetailOpenFor] = useState<string | null>(null);

  const markdown = opened?.compatibility ?? EMPTY_COMPATIBILITY;
  const writePolicy = opened?.writePolicy ?? DEFAULT_WRITE_POLICY;
  const access: DocumentAccess =
    editingAllowedFor === sessionKey
      ? "editable"
      : (opened?.access ?? "editable");
  const identityAdoptionVisible =
    writePolicy.mode === "confirmation-required" &&
    writePolicy.reason === "identity-adoption" &&
    access === "read-only" &&
    keptReadOnlyFor !== sessionKey;

  const openDetail = useCallback(() => {
    setDetailOpenFor(sessionKey);
  }, [sessionKey]);

  const closeDetail = useCallback(() => {
    setDetailOpenFor(null);
  }, []);

  const keepReadOnly = useCallback(() => {
    setKeptReadOnlyFor(sessionKey);
  }, [sessionKey]);

  const allowIdentityAdoption = useCallback(() => {
    if (pageId) services.documentSafety?.approveIdentityAdoption(pageId);
    setEditingAllowedFor(sessionKey);
  }, [pageId, services, sessionKey]);

  const allowLossyEditing = useCallback(() => {
    // C4：允许编辑同时批准有损来源会话授权（保存门槛）。
    if (pageId) services.documentSafety?.approveLossySource(pageId);
    setEditingAllowedFor(sessionKey);
  }, [pageId, services, sessionKey]);

  const approveLossyOutput = useCallback(() => {
    if (pageId) services.documentSafety?.approveLossyOutput(pageId);
  }, [pageId, services]);

  return {
    access,
    markdown,
    writePolicy,
    identityAdoptionVisible,
    detailOpen: detailOpenFor === sessionKey,
    openDetail,
    closeDetail,
    keepReadOnly,
    allowIdentityAdoption,
    allowLossyEditing,
    approveLossyOutput,
  };
}
