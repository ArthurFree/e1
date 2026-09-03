/**
 * R009 Stage 0.3（§3.4）：统一的 Desktop API mock 工厂。
 *
 * 背景：各测试文件曾各自手写 `as unknown as E1DesktopAPI` 的部分 mock
 * （缺 vaultState/secret/search 等组），运行时访问缺失方法报
 * 「Cannot read properties of undefined」，靠业务侧 fallback 才没挂，
 * 且契约演进时 mock 静默漂移。
 *
 * 本工厂以 shared/ipc/contracts 的 E1DesktopAPI 为唯一形状来源：
 * - 产物类型标注为 E1DesktopAPI（编译期强制对齐，契约加组/加方法即报错）；
 * - 每个方法都是 vi.fn，带「成功信封语义」的合理默认值（空列表/空状态），
 *   任何方法都可直接做调用断言；
 * - 支持按组部分覆盖；覆盖值为 undefined 时回退默认（等价于不传）。
 *
 * 注意：本模块只产出对象，不触碰 window.e1——注入由调用方完成
 * （src/test/ 虽在架构门禁豁免内，仍保持「工厂不越权」的单一职责）。
 */
import { vi } from "vitest";
import {
  createEmptyVaultState,
  type E1DesktopAPI,
  type SearchIndexStatus,
  type SecretStorageStatus,
  type UpdateStatus,
} from "../../shared/ipc/contracts";

/** 按组部分覆盖：键为 E1DesktopAPI 的服务组，值为该组方法的部分实现。 */
export type MockDesktopApiOverrides = {
  vault?: Partial<E1DesktopAPI["vault"]>;
  vaultState?: Partial<E1DesktopAPI["vaultState"]>;
  note?: Partial<E1DesktopAPI["note"]>;
  secret?: Partial<E1DesktopAPI["secret"]>;
  search?: Partial<E1DesktopAPI["search"]>;
  links?: Partial<E1DesktopAPI["links"]>;
  asset?: Partial<E1DesktopAPI["asset"]>;
  events?: Partial<E1DesktopAPI["events"]>;
  update?: Partial<E1DesktopAPI["update"]>;
  fileOperation?: Partial<E1DesktopAPI["fileOperation"]>;
  versions?: E1DesktopAPI["versions"];
};

/** 组合并：覆盖值 undefined 视为未提供（回退默认），其余替换默认实现。 */
function mergeGroup<T extends object>(defaults: T, overrides?: Partial<T>): T {
  if (!overrides) return defaults;
  const merged = { ...defaults } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as T;
}

/** 默认版本令牌（不透明字符串，仅供断言传参/断言形状，不代表真实 hash）。 */
const DEFAULT_TOKEN = `sha256:${"0".repeat(64)}`;

/**
 * 构造完整的 E1DesktopAPI mock。默认行为约定：
 * - 选择类（selectDirectory / asset.pick）返回 null（用户取消语义）；
 * - 列表/查询类返回空集合；状态类返回空状态（vaultState）或 missing（search）；
 * - 写操作返回成功结果（新令牌/操作 id），不产生副作用；
 * - events.subscribeVaultChanges 返回 no-op 取消订阅函数。
 */
export function createMockDesktopApi(
  overrides: MockDesktopApiOverrides = {},
): E1DesktopAPI {
  const vault: E1DesktopAPI["vault"] = {
    selectDirectory: vi.fn(async () => null),
    openSelection: vi.fn(async (input) => ({
      vaultId: input.initialize ? "v-mock" : "transient:mock",
      absolutePath: "/tmp/mock-vault",
      name: "mock-vault",
      displayName: "mock-vault",
      createdAt: "2026-08-09T00:00:00.000Z",
      initialized: input.initialize,
      transient: !input.initialize,
    })),
    openRecent: vi.fn(async (input) => ({
      vaultId: input.vaultId,
      absolutePath: `/tmp/${input.vaultId}`,
      name: input.vaultId,
      displayName: input.vaultId,
      createdAt: "2026-08-09T00:00:00.000Z",
      initialized: false,
    })),
    listRecent: vi.fn(async () => []),
    scan: vi.fn(async (vaultId) => ({
      vault: { vaultId, name: vaultId, assetsDirectory: "assets" },
      entries: [],
    })),
    createDirectory: vi.fn(async (input) => ({
      relativePath: input.parentRelativePath
        ? `${input.parentRelativePath}/${input.name}`
        : input.name,
    })),
    trash: vi.fn(async () => ({ operationId: "op-mock" })),
    listTrash: vi.fn(async () => ({ entries: [] })),
    restore: vi.fn(async () => ({ relativePath: "restored.md" })),
    purgeTrash: vi.fn(async () => ({ purged: 0 })),
    rename: vi.fn(async (input) => ({
      vaultId: input.vaultId,
      name: input.name,
    })),
  };

  const fileOperation: E1DesktopAPI["fileOperation"] = {
    plan: vi.fn(async (input) => ({
      operationId: "op-mock",
      kind: input.kind,
      vaultId: input.vaultId,
      target: {},
      pathMoves: [],
      patches: [],
      summary: {
        movedDocuments: 0,
        rewrittenDocuments: 0,
        rewrittenLinks: 0,
        rewrittenAssets: 0,
      },
      blockers: [],
      warnings: [],
      createdAt: Date.now(),
    })),
    execute: vi.fn(async (input) => ({
      operationId: input.plan.operationId,
      kind: input.plan.kind,
      vaultId: input.vaultId,
      pathMoves: input.plan.pathMoves,
      rewrittenDocuments: 0,
      rewrittenLinks: 0,
    })),
    recoveryStatus: vi.fn(async (input) => ({
      vaultId: input.vaultId,
      phase: "clean" as const,
      pendingOperationIds: [],
    })),
    recover: vi.fn(async (input) => ({
      vaultId: input.vaultId,
      recovered: true,
      rolledBackOperationIds: [],
    })),
  };

  const vaultState: E1DesktopAPI["vaultState"] = {
    get: vi.fn(async () => createEmptyVaultState()),
    patch: vi.fn(async () => createEmptyVaultState()),
  };

  const note: E1DesktopAPI["note"] = {
    read: vi.fn(async (input) => ({
      stableNoteId: null,
      relativePath: input.relativePath,
      markdown: "",
      versionToken: DEFAULT_TOKEN,
      source: { modifiedAt: 0, sizeBytes: 0 },
    })),
    create: vi.fn(async (input) => ({
      noteId: "01MOCK",
      relativePath: input.directory
        ? `${input.directory}/${input.title}.md`
        : `${input.title}.md`,
      versionToken: DEFAULT_TOKEN,
    })),
    save: vi.fn(async () => ({
      versionToken: DEFAULT_TOKEN,
      source: { modifiedAt: 0, sizeBytes: 0 },
    })),
    patchMetadata: vi.fn(async () => ({
      versionToken: DEFAULT_TOKEN,
      updatedAt: 0,
      stableNoteId: null,
    })),
    move: vi.fn(async (input) => {
      const baseName = input.relativePath.split("/").pop()!;
      return {
        relativePath: input.targetDirectory
          ? `${input.targetDirectory}/${baseName}`
          : baseName,
      };
    }),
    renameFile: vi.fn(async (input) => {
      const slash = input.relativePath.lastIndexOf("/");
      const directory = slash >= 0 ? input.relativePath.slice(0, slash) : "";
      return {
        relativePath: directory
          ? `${directory}/${input.newName}`
          : input.newName,
      };
    }),
    reveal: vi.fn(async () => {}),
  };

  const secret: E1DesktopAPI["secret"] = {
    status: vi.fn(async (): Promise<SecretStorageStatus> => ({
      mode: "secure-persistent",
    })),
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };

  const search: E1DesktopAPI["search"] = {
    query: vi.fn(async () => []),
    rebuild: vi.fn(async () => ({ indexedDocuments: 0 })),
    upsert: vi.fn(async () => ({ indexed: true })),
    remove: vi.fn(async () => {}),
    relocate: vi.fn(async () => {}),
    status: vi.fn(async (): Promise<SearchIndexStatus> => ({
      state: "missing",
    })),
  };

  /** R010 Stage 3：派生链接索引组（默认空结果/missing 状态）。 */
  const links: E1DesktopAPI["links"] = {
    outgoing: vi.fn(async () => []),
    backlinks: vi.fn(async () => []),
    broken: vi.fn(async () => []),
    rebuild: vi.fn(async () => ({ indexedDocuments: 0 })),
    upsert: vi.fn(async () => ({ indexed: true })),
    remove: vi.fn(async () => {}),
    relocate: vi.fn(async () => {}),
    analyzeRelocation: vi.fn(async () => []),
    status: vi.fn(async (): Promise<SearchIndexStatus> => ({
      state: "missing",
    })),
  };

  const asset: E1DesktopAPI["asset"] = {
    pick: vi.fn(async () => null),
    import: vi.fn(async (input) => ({
      assetId: `asset:${input.vaultId}:assets/${input.fileName}`,
      relativePath: `assets/${input.fileName}`,
      sizeBytes: 0,
      mimeType: input.mimeType,
    })),
    read: vi.fn(async (input) => ({
      assetId: input.assetId,
      name: "mock-asset",
      mimeType: "application/octet-stream",
      sizeBytes: 0,
      data: new Uint8Array(),
    })),
    resolveUrl: vi.fn(async (assetId) => `e1-asset://${assetId}`),
    reveal: vi.fn(async () => {}),
  };

  const events: E1DesktopAPI["events"] = {
    subscribeVaultChanges: vi.fn(() => () => {}),
    subscribeUpdateStatus: vi.fn(() => () => {}),
  };

  /** R009 Stage 6：默认未打包语义（state=unsupported，不触网）。 */
  const defaultUpdateStatus: UpdateStatus = {
    state: "unsupported",
    currentVersion: "0.1.0",
    canAutoInstall: false,
    releasePageUrl: "https://github.com/ArthurFree/e1/releases",
  };
  const update: E1DesktopAPI["update"] = {
    getState: vi.fn(async () => ({ ...defaultUpdateStatus })),
    check: vi.fn(async () => ({ ...defaultUpdateStatus })),
    download: vi.fn(async () => ({ ...defaultUpdateStatus })),
    install: vi.fn(async () => {}),
    openReleasePage: vi.fn(async () => {}),
  };

  return {
    platform: "desktop",
    versions: overrides.versions ?? {},
    vault: mergeGroup(vault, overrides.vault),
    vaultState: mergeGroup(vaultState, overrides.vaultState),
    note: mergeGroup(note, overrides.note),
    secret: mergeGroup(secret, overrides.secret),
    search: mergeGroup(search, overrides.search),
    links: mergeGroup(links, overrides.links),
    asset: mergeGroup(asset, overrides.asset),
    events: mergeGroup(events, overrides.events),
    update: mergeGroup(update, overrides.update),
    fileOperation: mergeGroup(fileOperation, overrides.fileOperation),
  };
}
