/**
 * R012 Stage 4（需求 §23 Safe Restore）：版本恢复的平台无关协调层。
 *
 * 编排（两个平台共享）：
 *   取目标版本（get）→ before-restore 快照（revisions.add——Web 存 JSON，
 *   Desktop 由 Main 重读磁盘 capture）→ port.restore（平台差异全部收口在
 *   port 内）。before-restore 已创建但 restore 随后失败时，允许保留该
 *   安全快照（§23 并发规则）。
 *
 * UI 不判断平台（DUAL-01）：VersionPanel → DocumentEditorController
 * .restoreRevision → 本协调器；AppServices.revisionRestore 双端均装配。
 *
 * - JsonRevisionRestorePort（Web/内存）：历史 contentJson 经白名单校验后
 *   由调用方的 commit 闭包（保存协调器串行提交）落盘，语义与 R004 INV-06
 *   一致——编辑器内容由 commit 回调更新；
 * - Desktop 实现见 platform/desktop/DesktopRevisionRestoreService：
 *   revision.restore IPC（Main 端 raw body 合并 + 乐观锁 + 原子写），
 *   返回 reloadedExternally=true，由调用方重新读盘重建编辑器。
 *
 * R012 Stage 5（需求 §27 Diff）：diffWithCurrent 提供「历史版本 vs 当前
 * 正文」的对比数据源——port.readCurrentSource 可选（Desktop 读磁盘 raw
 * body，与历史快照同口径），缺省回退编辑器 textSnapshot。
 */
import { DomainError } from "../../domain/errors";
import type { RevisionRepository } from "../../domain/repositories";
import type { DocumentRevision } from "../../domain/types";
import { parseDocumentContent } from "../../domain/validation/documentContent";

/** 恢复结果：Desktop 磁盘已被外部（Main）写入，编辑器需重新读盘重建。 */
export interface RevisionRestoreOutcome {
  reloadedExternally: boolean;
}

/** 平台特定恢复写入（Web=JSON 提交；Desktop=IPC raw body 合并落盘）。 */
export interface RevisionRestorePort {
  /**
   * 恢复前校验目标版本（可选）：失败抛 DomainError，协调器不产生
   * before-restore 快照（损坏版本不进入编辑器也不留存快照）。
   */
  validate?(target: DocumentRevision): void;
  /**
   * 当前正文对比源（可选，R012 Stage 5 §27 Diff）：Desktop 返回磁盘
   * raw Markdown body（与历史快照同口径）；未实现或读取失败返回
   * null/undefined 时，协调器回退用编辑器 textSnapshot 作对比源。
   */
  readCurrentSource?(pageId: string): Promise<string | null>;
  restore(input: {
    pageId: string;
    /** 目标版本（协调器已 get；Desktop 的 contentJson 恒为 null，不使用）。 */
    target: DocumentRevision;
    /** 编辑器当前快照（Web before-restore/提交链用；Desktop 忽略）。 */
    current: { contentJson: unknown; textSnapshot: string };
    /**
     * 经保存协调器串行提交目标内容（INV-06：旧防抖保存不可能覆盖恢复
     * 结果）；Desktop 实现不调用——磁盘已由 Main 原子写入。
     */
    commit: (contentJson: unknown, textSnapshot: string) => Promise<unknown>;
  }): Promise<RevisionRestoreOutcome>;
}

export class RevisionRestoreCoordinator {
  constructor(
    private readonly deps: {
      revisions: RevisionRepository;
      port: RevisionRestorePort;
    },
  ) {}

  /**
   * 恢复指定历史版本。调用方负责先 flush pending autosave（失败/conflict
   * 不进入本方法）。抛 DomainError：REVISION_NOT_FOUND / CORRUPTED_DOCUMENT
   * / DOCUMENT_CONFLICT 等，由 UI 按 code 分流。
   */
  async restoreRevision(input: {
    pageId: string;
    revisionId: string;
    current: { contentJson: unknown; textSnapshot: string };
    commit: (contentJson: unknown, textSnapshot: string) => Promise<unknown>;
  }): Promise<RevisionRestoreOutcome> {
    const target = await this.deps.revisions.get(
      input.pageId,
      input.revisionId,
    );
    if (!target) {
      throw new DomainError(
        "REVISION_NOT_FOUND",
        "该版本已不存在或无法读取，恢复已取消。",
      );
    }
    // 目标校验先于 before-restore：损坏版本不产生快照也不进编辑器。
    this.deps.port.validate?.(target);
    // before-restore 安全快照（§23）：先留存当前正文，再执行恢复。
    await this.deps.revisions.add(
      input.pageId,
      input.current.contentJson,
      input.current.textSnapshot,
      "before-restore",
    );
    return this.deps.port.restore({
      pageId: input.pageId,
      target,
      current: input.current,
      commit: input.commit,
    });
  }

  /**
   * 历史版本 vs 当前正文的对比数据源（R012 Stage 5，需求 §27 Diff）。
   *
   * - 目标版本不存在/不可读 → null（UI 提示「该版本已不存在或无法读取」）；
   * - historical = 目标版本 textSnapshot（Desktop 为 raw Markdown body）；
   * - current = port.readCurrentSource（Desktop：磁盘 raw body，与历史
   *   快照同口径）；port 未实现或读取失败时回退编辑器 textSnapshot。
   *
   * 只取数据不做 diff 计算（行级 diff 在 UI 侧 computeLineDiff 完成）。
   */
  async diffWithCurrent(input: {
    pageId: string;
    revisionId: string;
    /** 编辑器当前 textSnapshot（port 无 readCurrentSource 时的回退）。 */
    currentTextSnapshot: string;
  }): Promise<{ historical: string; current: string } | null> {
    const target = await this.deps.revisions.get(
      input.pageId,
      input.revisionId,
    );
    if (!target) return null;
    const current =
      (await this.deps.port.readCurrentSource?.(input.pageId)) ??
      input.currentTextSnapshot;
    return { historical: target.textSnapshot, current };
  }
}

/**
 * JSON 内容恢复（Web/内存运行时）：目标版本 contentJson 过白名单校验后
 * 经 commit 闭包串行提交（原 R004 restoreRevision 链路的恢复语义，
 * before-restore 已由协调器统一完成）。
 */
export class JsonRevisionRestorePort implements RevisionRestorePort {
  /** 损坏版本不进入编辑器、不写回存储（R003 阶段 4 语义）。 */
  validate(target: DocumentRevision): void {
    if (!parseDocumentContent(target.contentJson).ok) {
      throw new DomainError("CORRUPTED_DOCUMENT", "该版本内容损坏，无法恢复。");
    }
  }

  async restore(
    input: Parameters<RevisionRestorePort["restore"]>[0],
  ): Promise<RevisionRestoreOutcome> {
    // validate 已过：此处 parse 必成功。
    const parsed = parseDocumentContent(input.target.contentJson);
    if (!parsed.ok) {
      throw new DomainError("CORRUPTED_DOCUMENT", "该版本内容损坏，无法恢复。");
    }
    await input.commit(parsed.value, input.target.textSnapshot);
    return { reloadedExternally: false };
  }
}
