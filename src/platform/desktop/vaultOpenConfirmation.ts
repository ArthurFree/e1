/**
 * R006-C2.1（FR-03，r006-c3 §10）：未初始化文件夹「三选项确认」握手。
 *
 * 背景：打开本地知识库走既有 createWorkspace 命令链（Provider 零改动），
 * 但 DesktopWorkspaceRepository.create 选中未初始化目录时不能擅自初始化
 * （PR-01 打开不等于接管），需要用户先在确认框中选择。仓储（platform 层）
 * 与确认框（components 层）之间没有直接引用，故用本模块级单例做两段握手：
 *
 * 第一段（仓储）：selectDirectory 返回未初始化 → stash() 挂起
 *   {selectionToken, displayName} → 抛 DomainError("VAULT_CONFIRMATION_REQUIRED")；
 * 第二段（UI）：GlobalSidebar 接住该错误 → peek() 取 displayName 弹确认框：
 *   - 取消 → discard()（令牌留在 Main 侧自然过期，不写任何文件）；
 *   - 仅预览 / 初始化并打开 → decide(initialize) 记录决定后重走
 *     createWorkspace → 仓储 create 开头 takeDecision() 消费决定，调
 *     vault.openSelection 完成打开。
 *
 * 单例进程内有效：Web 端永远不写入（桌面能力门控才进入该链路），
 * 模块无副作用、可安全被 Web 打包。
 */

/** 挂起中的目录选择（等待用户确认）。 */
export interface PendingVaultSelection {
  /** Main 签发的一次性授权令牌（openSelection 的凭证）。 */
  selectionToken: string;
  /** 目录展示名（确认框文案用）。 */
  displayName: string;
}

/** 用户已做的确认决定（仓储第二段消费）。 */
export interface VaultSelectionDecision {
  selectionToken: string;
  initialize: boolean;
}

let pending: PendingVaultSelection | null = null;
let decision: VaultSelectionDecision | null = null;

/** 仓储第一段：挂起选择并等待用户确认。 */
export function stashPendingVaultSelection(
  selection: PendingVaultSelection,
): void {
  pending = selection;
  decision = null;
}

/** UI：读取挂起的选择（确认框文案）；无挂起返回 null。 */
export function peekPendingVaultSelection(): PendingVaultSelection | null {
  return pending;
}

/** UI：用户选择「仅预览」（false）或「初始化并打开」（true）。 */
export function decidePendingVaultSelection(initialize: boolean): void {
  if (!pending) return;
  decision = { selectionToken: pending.selectionToken, initialize };
  pending = null;
}

/** UI：用户取消——丢弃挂起（Main 侧令牌 5 分钟后自然过期）。 */
export function discardPendingVaultSelection(): void {
  pending = null;
  decision = null;
}

/** 仓储第二段：取出并清除用户决定；无决定返回 null（走正常目录选择）。 */
export function takePendingVaultDecision(): VaultSelectionDecision | null {
  const current = decision;
  decision = null;
  return current;
}
