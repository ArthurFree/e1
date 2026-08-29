/**
 * Vitest globalSetup：测试临时目录收进项目内 test-results/tmp 并重定向
 * TMPDIR（语义见 ./projectTmp.ts）。globalSetup 在 worker fork 前执行，
 * env 变更对所有测试进程生效（包括直接 npx vitest 调用）。
 */
import { setupProjectTmpDir } from "./projectTmp";

export default function setup(): void {
  setupProjectTmpDir();
}
