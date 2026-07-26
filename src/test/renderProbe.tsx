/**
 * 渲染计数 probe（R003 阶段 6）：验证 Context 渲染隔离的测试基建。
 * Probe 每次渲染计数 +1，与窄 hook 消费者组合即可断言
 * 「某状态域变化只让其消费者重渲染」。
 */

/** 渲染计数器与配套 probe 组件。 */
export interface RenderProbe {
  count: { current: number };
  Probe(): null;
}

export function createRenderProbe(): RenderProbe {
  const count = { current: 0 };
  function Probe() {
    count.current += 1;
    return null;
  }
  return { count, Probe };
}
