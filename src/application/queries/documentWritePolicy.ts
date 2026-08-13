/**
 * 文档写入策略（R006-C4 FR-01/03/04）：区分「运行时能否保存」与「当前文档能否保存」。
 *
 * Desktop 打开时按 Vault 状态 / Markdown 兼容性 / 稳定 ID 判定；
 * Web 恒为 read-write。会话授权（lossy / identity）只属于当前打开会话，
 * 不永久记忆——重新打开文档后重新判断。
 */

/** 文档级写入策略（R006-C4 FR-01）。 */
export type DocumentWritePolicy =
  | { mode: "read-write" }
  | {
      mode: "confirmation-required";
      reason: "lossy-source" | "lossy-output" | "identity-adoption";
    }
  | {
      mode: "read-only";
      reason: "transient-vault" | "permission" | "unsupported-source";
    };

/**
 * 当前文档会话的写入授权（R006-C4 FR-04）。
 * 全部默认 false；用户显式确认后置 true；关闭/重开文档后清空。
 */
export interface DocumentWriteSessionState {
  sourceLossyApproved: boolean;
  outputLossyApproved: boolean;
  identityAdoptionApproved: boolean;
}

/** 打开瞬间判定 writePolicy 所需的只读输入。 */
export interface WritePolicyInput {
  /** 是否为仅预览（transient）Vault。 */
  transient: boolean;
  /** Markdown → Tiptap 解析是否有损（unsupported 非空）。 */
  lossy: boolean;
  /** Frontmatter id；缺失则为 null（会话 id 可能是 path:*）。 */
  stableNoteId: string | null;
}

/** Web / 已初始化且无损且有稳定 ID 的默认策略。 */
export const DEFAULT_WRITE_POLICY: DocumentWritePolicy = { mode: "read-write" };

/** 空会话授权（每次打开文档的起点）。 */
export function createEmptyWriteSessionState(): DocumentWriteSessionState {
  return {
    sourceLossyApproved: false,
    outputLossyApproved: false,
    identityAdoptionApproved: false,
  };
}

/**
 * 打开时判定写入策略（R006-C4 FR-03）。
 * 优先级：transient → lossy-source → identity-adoption → read-write。
 */
export function resolveWritePolicy(input: WritePolicyInput): DocumentWritePolicy {
  if (input.transient) {
    return { mode: "read-only", reason: "transient-vault" };
  }
  if (input.lossy) {
    return { mode: "confirmation-required", reason: "lossy-source" };
  }
  if (!input.stableNoteId) {
    return { mode: "confirmation-required", reason: "identity-adoption" };
  }
  return { mode: "read-write" };
}

/**
 * 由 writePolicy 推导编辑器 access（与 C3 access 字段并存）。
 * - read-write：可编辑；
 * - confirmation-required / read-only：默认只读——lossy 经「允许本次编辑」
 *   后可本地编辑，保存另需会话授权（C4-E）；identity-adoption 经 F 确认前保持只读。
 */
export function accessFromWritePolicy(
  policy: DocumentWritePolicy,
): "editable" | "read-only" {
  return policy.mode === "read-write" ? "editable" : "read-only";
}

/** vaultId 是否为仅预览会话（Main 签发的 transient:<uuid>）。 */
export function isTransientVaultId(vaultId: string): boolean {
  return vaultId.startsWith("transient:");
}
