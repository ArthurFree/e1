/**
 * 测试临时目录收口（2026-08-29 约定）：所有测试产生的临时文件只能落在
 * 项目内 `test-results/tmp/`（随 test-results 被 gitignore），不得写系统
 * 临时目录或项目之外的任何位置。
 *
 * 实现方式：把 `process.env.TMPDIR` 重定向到项目内目录——`os.tmpdir()`
 * 与 Node/Electron 的临时文件 API 都读取该环境变量，vitest worker 与
 * playwright worker/被测 Electron 进程继承主进程 env，因此现有测试中
 * 所有 mkdtemp(os.tmpdir()) 夹具无需逐个修改即可全部收口。
 *
 * 每次测试运行前清空重建该目录，避免夹具泄漏累积（历史教训：系统
 * $TMPDIR 下曾累积约 4000 个 e1-* 夹具目录 / 484MB）。
 *
 * 接入点：vite.config.ts / vitest.perf.config.ts 的 test.globalSetup，
 * 以及 playwright.config.ts 顶部（config 加载即在主进程执行，先于我
 * 们 fork 的任何 worker）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** 项目内测试临时目录的绝对路径（以项目根为 cwd 运行测试为前提）。 */
export const PROJECT_TMP_DIR = join(process.cwd(), "test-results", "tmp");

/** 清空重建项目内测试临时目录，并把 TMPDIR 重定向到它。 */
export function setupProjectTmpDir(): void {
  rmSync(PROJECT_TMP_DIR, { recursive: true, force: true });
  mkdirSync(PROJECT_TMP_DIR, { recursive: true });
  process.env.TMPDIR = PROJECT_TMP_DIR;
}
