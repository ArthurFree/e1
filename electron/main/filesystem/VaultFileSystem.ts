/**
 * R006 阶段 2：Vault 文件系统层（r006 §6/§7/§8/§15）。
 *
 * 职责：
 * - readVault：读取 .e1/vault.json。**不存在或损坏时不修改任何文件**
 *   （US-01：不修改原文件内容即可完成首次打开）——不存在视为未初始化
 *   Vault，返回 suggestedName 供用户确认后初始化；存在但非法（坏 JSON /
 *   format 不符 / formatVersion 不支持）抛 INVALID_INPUT，绝不静默重建
 *   （重建会生成新 vaultId，破坏既有笔记 Frontmatter id 的归属语义）。
 * - initializeVault：创建 .e1/vault.json + assets/（US-02）；幂等——
 *   已是 Vault 时直接返回既有 meta，不覆写。
 * - scanVault：递归扫描映射页面树（r006 §7：文件夹 → group、.md →
 *   document），**只读**，不修改用户文件夹。
 *
 * vaultId 生成用 node:crypto 的 randomUUID：项目 src 侧的 ULID 实现不可
 * 达（electron 不得 import src），randomUUID 零依赖且满足「稳定且唯一」；
 * vault.json 只要求 opaque 字符串，不依赖 ULID 的时间序特性。
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import type {
  VaultScanEntry,
  VaultScanResult,
} from "../../../shared/ipc/contracts.js";
import { splitFrontmatter } from "../../../shared/markdown/frontmatter.js";

/** .e1/vault.json 的内存形态（r006 §6.1；不记录任何机器绝对路径与本机状态）。 */
export interface VaultMeta {
  format: "e1-vault";
  formatVersion: 1;
  vaultId: string;
  name: string;
  createdAt: string;
  assetsDirectory: string;
  identityMode: "frontmatter";
}

export type ReadVaultResult =
  | { status: "initialized"; meta: VaultMeta }
  | { status: "uninitialized"; suggestedName: string };

const VAULT_DIR = ".e1";
const VAULT_FILE = join(VAULT_DIR, "vault.json");
const SUPPORTED_FORMAT_VERSION = 1;

/**
 * 扫描时只读每个 .md 的头部提取 Frontmatter（r006 §6.2 身份字段在文件头），
 * 避免大文件全量读入；头部内未闭合的 Frontmatter 按「无 Frontmatter」处理，
 * 标题回退文件名（保守策略：宁可回退也不截断误解析）。
 */
const FRONTMATTER_HEAD_BYTES = 8192;

/** 读取 .e1/vault.json；不存在 → uninitialized，非法 → INVALID_INPUT。 */
export async function readVault(root: string): Promise<ReadVaultResult> {
  let raw: string;
  try {
    raw = await readFile(join(root, VAULT_FILE), "utf8");
  } catch {
    // 文件不存在（含 .e1 目录不存在）：未初始化的普通文件夹，不改任何文件。
    return { status: "uninitialized", suggestedName: basename(root) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IpcFailure(
      "INVALID_INPUT",
      ".e1/vault.json 不是合法 JSON（文件保持原样，未做任何修改）",
    );
  }
  return { status: "initialized", meta: parseVaultMeta(parsed) };
}

/** vault.json 形状校验；任何不符抛 INVALID_INPUT。 */
function parseVaultMeta(parsed: unknown): VaultMeta {
  const invalid = (reason: string): never => {
    throw new IpcFailure("INVALID_INPUT", `.e1/vault.json 非法：${reason}`);
  };
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid("不是对象");
  }
  const record = parsed as Record<string, unknown>;
  if (record.format !== "e1-vault") invalid('format 必须为 "e1-vault"');
  if (record.formatVersion !== SUPPORTED_FORMAT_VERSION) {
    invalid(`不支持的 formatVersion：${String(record.formatVersion)}`);
  }
  if (typeof record.vaultId !== "string" || record.vaultId.trim() === "") {
    invalid("vaultId 缺失或为空");
  }
  if (typeof record.name !== "string" || record.name.trim() === "") {
    invalid("name 缺失或为空");
  }
  // Record 索引访问不保留类型收窄，提取局部常量。
  const { vaultId, name } = record as { vaultId: string; name: string };
  return {
    format: "e1-vault",
    formatVersion: 1,
    vaultId,
    name,
    createdAt:
      typeof record.createdAt === "string"
        ? record.createdAt
        : new Date(0).toISOString(),
    assetsDirectory:
      typeof record.assetsDirectory === "string"
        ? record.assetsDirectory
        : "assets",
    identityMode: "frontmatter",
  };
}

/**
 * 初始化 Vault（US-02 / 首次打开经用户确认）：创建 .e1/vault.json 与
 * assets/。幂等——已是合法 Vault 时直接返回既有 meta（不覆写 vaultId）。
 */
export async function initializeVault(
  root: string,
  name?: string,
): Promise<VaultMeta> {
  const existing = await readVault(root);
  if (existing.status === "initialized") return existing.meta;

  const meta: VaultMeta = {
    format: "e1-vault",
    formatVersion: 1,
    vaultId: randomUUID(),
    name: name?.trim() || existing.suggestedName,
    createdAt: new Date().toISOString(),
    assetsDirectory: "assets",
    identityMode: "frontmatter",
  };
  await mkdir(join(root, VAULT_DIR), { recursive: true });
  await mkdir(join(root, meta.assetsDirectory), { recursive: true });
  await writeFile(
    join(root, VAULT_FILE),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );
  return meta;
}

/**
 * 递归扫描 Vault，文件夹 → group、.md → document（r006 §7）。
 * 跳过：.e1/ 与一切点开头隐藏项、node_modules、符号链接（目录不跟随、
 * 文件不收录——防止经 symlink 把 Vault 外内容扫进页面树，r006 §17）。
 * 已初始化 Vault 的 assetsDirectory（默认 assets/，仅根层级）同样跳过：
 * 它是受管附件存储（r006 §13），不应映射为笔记分组；未初始化目录无此
 * 约定，名为 assets 的普通目录照常收录（取舍在此锁定）。
 *
 * 排序（r006 §8 文件名排序）：每个目录内先 group 后 document，各按名称
 * localeCompare("zh-CN") 比较——选择 zh-CN 比较器在此锁定；Node 带完整
 * ICU，中文按拼音序、跨平台确定性可接受（数值感知不开启）。
 */
export async function scanVault(root: string): Promise<VaultScanResult> {
  // 根经 realpath 对齐（macOS /tmp → /private/tmp），保证相对路径计算稳定。
  const rootReal = await realpath(root);
  // readVault 只在 vault.json 存在但非法时抛 INVALID_INPUT——此处让它向上
  // 传播（扫描一个元数据损坏的 Vault 应当显式失败，而不是伪装成未初始化）。
  const meta = await readVault(rootReal);
  // 受管附件目录（仅根层级跳过）：已初始化 Vault 取 vault.json 的
  // assetsDirectory；未初始化目录无受管存储约定。
  const managedAssetsDir =
    meta.status === "initialized" ? meta.meta.assetsDirectory : null;
  const entries: VaultScanEntry[] = [];
  await walk(rootReal, rootReal, entries, managedAssetsDir);
  return {
    vault:
      meta.status === "initialized"
        ? { vaultId: meta.meta.vaultId, name: meta.meta.name }
        : { vaultId: null, name: basename(rootReal) },
    entries,
  };
}

/** DFS 遍历：每目录先收集再排序（group 在前），保证输出确定性。 */
async function walk(
  root: string,
  dir: string,
  entries: VaultScanEntry[],
  skipDirAtRoot: string | null,
): Promise<void> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const isRoot = dir === root;
  const groups: string[] = [];
  const docs: string[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
    if (dirent.isSymbolicLink()) continue; // 不跟随、不收录（防逃逸扫描）
    if (isRoot && dirent.name === skipDirAtRoot) continue; // 受管附件目录
    if (dirent.isDirectory()) {
      groups.push(dirent.name);
    } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith(".md")) {
      docs.push(dirent.name);
    }
  }
  const byName = (a: string, b: string) => a.localeCompare(b, "zh-CN");
  groups.sort(byName);
  docs.sort(byName);

  const parentRelative = toPosix(relative(root, dir));
  const parentPath = parentRelative === "" ? null : parentRelative;

  for (const name of groups) {
    const relativePath = parentPath === null ? name : `${parentPath}/${name}`;
    entries.push({
      noteId: null,
      relativePath,
      kind: "group",
      title: name,
      parentPath,
      tags: [],
    });
    await walk(root, join(dir, name), entries, null);
  }
  for (const name of docs) {
    const absolute = join(dir, name);
    const head = await readHead(absolute);
    const { metadata } = splitFrontmatter(head.replace(/\r\n/g, "\n"));
    const fallbackTitle = name.replace(/\.md$/i, "");
    entries.push({
      noteId: metadata.id ?? null,
      relativePath: parentPath === null ? name : `${parentPath}/${name}`,
      kind: "document",
      title: metadata.title?.trim() || fallbackTitle,
      parentPath,
      tags: metadata.tags,
    });
  }
}

/** 绝对路径相对根 → POSIX 风格相对路径（跨平台统一 "/" 分隔）。 */
function toPosix(relativePath: string): string {
  return relativePath.split(sep).join("/");
}

/** 只读文件头部 FRONTMATTER_HEAD_BYTES 字节；读取失败按无 Frontmatter 处理。 */
async function readHead(absolutePath: string): Promise<string> {
  try {
    const handle = await open(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(FRONTMATTER_HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

/** vault.open 的入参校验辅助：绝对路径 + 必须是已存在目录（供 IPC 层使用）。 */
export async function assertVaultRootDirectory(
  absolutePath: string,
): Promise<void> {
  // Windows 盘符与 POSIX 绝对路径都算绝对；相对路径一律拒绝。
  if (
    !absolutePath.startsWith("/") &&
    !/^[a-zA-Z]:[\\/]/.test(absolutePath) &&
    !absolutePath.startsWith("\\\\")
  ) {
    throw new IpcFailure(
      "INVALID_INPUT",
      `vault.open 需要绝对路径：${absolutePath}`,
    );
  }
  let stats;
  try {
    stats = await stat(absolutePath);
  } catch {
    throw new IpcFailure(
      "VAULT_NOT_FOUND",
      `目录不存在或不可访问：${absolutePath}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new IpcFailure("INVALID_INPUT", `不是目录：${absolutePath}`);
  }
}
