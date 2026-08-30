/**
 * 自定义 jsdom 测试环境（R009 Stage 0.1 根治）：在销毁 jsdom 全局之前，
 * 先让出若干轮宏任务，排空事件循环里挂起的回调。
 *
 * 背景：React dev 构建的调度回调（performWorkOnRootViaSchedulerTask 与
 * commitRootImpl 中以 NormalPriority 调度的 passive effects flush）进入
 * 真实宏任务队列（setImmediate / MessageChannel），回调内读取
 * window.event。测试文件结束时若回调仍悬在队列里，Vitest 销毁 jsdom
 * 环境后回调才执行，抛 unhandled "ReferenceError: window is not defined"
 * （CI coverage 模式 instrumentation 拖慢时序，本地绿、远端红的根因）。
 *
 * 这里在 teardown 前排空宏任务，使挂起的回调在 window 仍存在时执行完毕。
 * 这不是压制错误：回调照常执行，其内部的真实异常仍会抛出并被 Vitest
 * 归因到当前测试文件。
 */
import { builtinEnvironments, type Environment } from "vitest/runtime";
import { setImmediate as waitImmediate } from "node:timers/promises";

/**
 * 排空轮数上限：每轮让当前已入队的宏任务全部执行，执行期间级联新入队
 * 的任务在下一轮清理；20 轮足以覆盖测试残留的多级异步链。
 */
const DRAIN_ROUNDS = 20;

const jsdom = builtinEnvironments.jsdom;

const environment: Environment = {
  name: "jsdom",
  viteEnvironment: "client",
  async setup(global, options) {
    const inner = await jsdom.setup(global, options);
    return {
      async teardown(teardownGlobal) {
        // 先排空宏任务队列，再销毁 jsdom 全局。
        for (let round = 0; round < DRAIN_ROUNDS; round += 1) {
          await waitImmediate();
        }
        await inner.teardown(teardownGlobal);
      },
    };
  },
};

export default environment;
