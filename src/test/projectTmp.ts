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
 * 目录布局：每次运行独占 `run-<pid>-<ts>` 子目录（多个测试进程并发
 * 运行时互不干扰——曾出现 vitest 运行中被并发的 playwright config
 * 加载清空共享目录导致 ENOENT 的事故）；启动时顺带清扫 24h 前的
 * 历史运行目录，避免夹具泄漏累积（历史教训：系统 $TMPDIR 下曾累积
 * 约 4000 个 e1-* 夹具目录 / 484MB）。
 *
 * 接入点：vite.config.ts / vitest.perf.config.ts 的 test.globalSetup，
 * 以及 playwright.config.ts 顶部（config 加载即在主进程执行，先于我
 * 们 fork 的任何 worker）。
 */
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** 项目内测试临时目录根（以项目根为 cwd 运行测试为前提）。 */
export const PROJECT_TMP_ROOT = join(process.cwd(), "test-results", "tmp");

/** 历史运行目录的保留时长（超过即清扫）。 */
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * 为本次运行创建独占临时子目录并把 TMPDIR 指向它；
 * 顺带清扫过期的历史运行目录。
 */
export function setupProjectTmpDir(): void {
  mkdirSync(PROJECT_TMP_ROOT, { recursive: true });
  const cutoff = Date.now() - STALE_MS;
  for (const name of readdirSync(PROJECT_TMP_ROOT)) {
    if (!name.startsWith("run-")) continue;
    try {
      if (statSync(join(PROJECT_TMP_ROOT, name)).mtimeMs < cutoff) {
        rmSync(join(PROJECT_TMP_ROOT, name), { recursive: true, force: true });
      }
    } catch {
      // 并发运行正在使用的目录清不掉时跳过，不影响本次运行。
    }
  }
  const runDir = join(
    PROJECT_TMP_ROOT,
    `run-${process.pid}-${Date.now().toString(36)}`,
  );
  mkdirSync(runDir, { recursive: true });
  process.env.TMPDIR = runDir;
}

