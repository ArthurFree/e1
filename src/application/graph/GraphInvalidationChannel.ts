/**
 * R015.1：图谱失效通道。LinkIndex 变更后 generation++，UI 重新查询。
 * UI 不得直接订阅文件系统 watcher。
 */
export class GraphInvalidationChannel {
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(): void {
    this.generation += 1;
    for (const listener of this.listeners) listener();
  }

  getGeneration(): number {
    return this.generation;
  }
}
