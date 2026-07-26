/**
 * 测试基础设施：固定测试数据生成器与异步时序控制工具（R003 阶段 0）。
 *
 * - 实体工厂使用确定性 ID 与时间戳（避免随机 createId），断言可重复；
 * - createDeferred 让竞态测试精确控制仓储 Promise 的完成顺序；
 * - sleep 用于跨过防抖窗口等真实计时器等待。
 */
import type { Page, PageKind, Tag, Workspace } from "../domain/types";

let seq = 0;

/** 在测试的 beforeEach 中调用，保证同一用例内 ID 确定性。 */
export function resetFixtureSeq(): void {
  seq = 0;
}

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** 固定基准时间戳：2023-11-14T22:13:20Z，避免测试依赖真实时钟。 */
export const FIXTURE_BASE_TIME = 1_700_000_000_000;

export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const id = overrides.id ?? nextId("ws");
  return {
    id,
    name: `知识库 ${id}`,
    icon: null,
    description: "",
    homePageId: null,
    favoriteAt: null,
    lastOpenedAt: null,
    createdAt: FIXTURE_BASE_TIME,
    updatedAt: FIXTURE_BASE_TIME,
    ...overrides,
  };
}

export function makePage(
  overrides: Partial<Page> & { workspaceId: string; kind?: PageKind },
): Page {
  const id = overrides.id ?? nextId("page");
  return {
    id,
    parentId: null,
    kind: "document",
    title: `页面 ${id}`,
    icon: null,
    position: 0,
    favoriteAt: null,
    lastOpenedAt: null,
    deletedAt: null,
    createdAt: FIXTURE_BASE_TIME,
    updatedAt: FIXTURE_BASE_TIME,
    ...overrides,
  };
}

export function makeTag(
  overrides: Partial<Tag> & { workspaceId: string },
): Tag {
  const id = overrides.id ?? nextId("tag");
  return {
    id,
    name: `标签 ${id}`,
    color: "#22A06B",
    ...overrides,
  };
}

/** 手动控制完成时机的 Promise，用于并发/竞态测试精确编排完成顺序。 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 真实计时器等待：用于跨过 800ms 保存防抖窗口等场景。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
