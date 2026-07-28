/**
 * 文档编辑器控制器（R004 阶段 3）：外部写入（版本恢复）与编辑器保存的
 * 串行化边界。由 DocumentEditor 实现并暴露给面板类组件。
 *
 * 背景：旧版本恢复流程「editor.setContent + contentRepository.save」双路径
 * 写回，与 DocumentEditor 的 800ms 防抖保存互相竞争（INV-06）。控制器把
 * 恢复编排为：flush 防抖与协调器队列 → 取当前快照 → before-restore 版本 →
 * 经协调器串行提交目标版本 → 更新编辑器但不产生第二次保存。
 */
export interface DocumentEditorController {
  /** 当前编辑器内容快照。 */
  getSnapshot(): { contentJson: unknown; textSnapshot: string };
  /** 提交挂起的防抖保存并排空协调器队列。 */
  flush(): Promise<void>;
  /**
   * 恢复指定内容：先落盘 before-restore 版本（当前内容），
   * 再经保存协调器串行提交目标内容（搜索索引随提交同步）。
   * 目标内容必须先经白名单校验（调用方负责）。
   */
  restore(input: { contentJson: unknown; textSnapshot: string }): Promise<void>;
}
