/**
 * @file R006-C2.1（FR-03 / r006-c3 §36.1）：普通文件夹首次打开确认框。
 * 用户经原生目录选择器选中一个未初始化的 Markdown 文件夹后弹出：
 * [取消] 不写任何文件；[仅预览] 建立 transient 会话（可扫描阅读，
 * 写路径整体禁用）；[初始化并打开] 才创建 .e1/vault.json 与 assets/。
 * 现有 Markdown 文件在任何选项下都不会被主动修改。
 */

import { Dialog } from "../ui/Dialog";

interface VaultConfirmDialogProps {
  /** 目录展示名（basename）。 */
  displayName: string;
  /** 取消（遮罩点击 / Escape / 取消按钮）：不写任何文件。 */
  onCancel(): void;
  /** 仅预览：initialize=false（transient 会话，不写注册表）。 */
  onPreview(): void;
  /** 初始化并打开：initialize=true（创建 .e1/vault.json 与 assets/）。 */
  onInitialize(): void;
}

/** 未初始化文件夹的三选项确认框（FR-03 文案在此锁定）。 */
export function VaultConfirmDialog({
  displayName,
  onCancel,
  onPreview,
  onInitialize,
}: VaultConfirmDialogProps) {
  return (
    <Dialog label="打开本地文件夹" className="modal" onClose={onCancel}>
      <h2 className="modal__title">这是一个普通 Markdown 文件夹</h2>
      <div className="modal__form">
        <p>
          「{displayName}」尚未初始化为 E1 知识库，E1 可以直接预览其中的
          Markdown。
        </p>
        <p>
          初始化后将新增 <code>.e1/vault.json</code> 与 <code>assets/</code>
          ；现有 Markdown 文件不会被主动修改。
        </p>
        <div className="modal__actions">
          <button type="button" className="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="button" onClick={onPreview}>
            仅预览
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={onInitialize}
          >
            初始化并打开
          </button>
        </div>
      </div>
    </Dialog>
  );
}
