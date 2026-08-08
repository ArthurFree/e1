/**
 * 最小 ZIP reader（R005 阶段 7，批次 7B）：Portable Vault 导入侧的解压入口，
 * 与同目录 zip.ts 的 writer 共用 CRC32 查找表（crc32 直接从 zip.ts 导入）。
 *
 * 能力面：
 * - 解析 EOCD（从文件尾 64KB 内回扫，兼容 zip 注释）+ central directory
 *   + local file header，条目数据起点以 local header 为准（name/extra
 *   长度以本地头为准，与 central 可能不同）；
 * - 支持 STORED（0）与 Deflate（8）两种压缩方式；Deflate 经
 *   `DecompressionStream("deflate-raw")` 解压（浏览器与 Node 18+ 均有，
 *   vitest jsdom 环境走 Node 实现，已验证无需 polyfill；jsdom 的 Blob
 *   没有 .stream()，因此用手工 ReadableStream 喂数据）；
 * - 文件名一律按 UTF-8 解码（writer 侧已置 EFS flag；未置位的归档按
 *   UTF-8 解码对本格式同样正确——Portable Vault 只由本应用/未来
 *   Desktop 生成，不支持 legacy 代码页）；
 * - 完整性：解压后校验未压缩大小与 CRC32，损坏即抛错；
 * - 路径安全（防 zip slip）：拒绝绝对路径（`/` 开头、盘符 `C:`）、
 *   含 `..` 段的条目名——导入方会把条目名拼到目标目录下，恶意条目
 *   不得逃逸出 vault 根；目录条目（`/` 结尾）跳过不返回；
 * - 加密条目（general purpose flag 第 0 位）与 Deflate 以外的压缩
 *   方法直接拒绝。
 *
 * 非法/损坏输入统一抛 `ZipReadError`（message 为中文用户文案），由
 * VaultImportService 包装为领域错误对外。
 */
import { DomainError } from "../../domain/errors";
import { crc32 } from "./zip";

/** 读取失败错误：kind 供程序区分「不是 zip / 结构损坏 / 不支持的特性」。 */
export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipReadError";
  }
}

/** 解压出的一个文件条目（目录条目不返回）。 */
export interface ZipReadEntry {
  /** 条目名（UTF-8，`/` 分隔，已通过路径安全校验）。 */
  name: string;
  data: Uint8Array;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
/** EOCD 注释最大 65535 字节，回扫窗口 = EOCD 最小长度 + 注释上限。 */
const EOCD_SCAN_WINDOW = EOCD_SIZE + 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** general purpose flag：第 0 位 = 加密。 */
const FLAG_ENCRYPTED = 0x0001;

const decoder = new TextDecoder();

/** 经 DecompressionStream 解压 deflate-raw 字节流。 */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new ZipReadError(
      "当前环境不支持 Deflate 解压（DecompressionStream 缺失）。",
    );
  }
  // jsdom 的 Blob 无 .stream()，手工构造 ReadableStream 喂数据。
  // DOM 泛型下 DecompressionStream 的 writable 声明为 BufferSource，
  // 与 ReadableStream<Uint8Array> 的 pipeThrough 形参不变性冲突，
  // 这里收窄一次类型（运行时 Uint8Array 本就是合法输入）。
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const transform = new DecompressionStream(
    "deflate-raw",
  ) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const reader = source.pipeThrough(transform).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * 路径安全校验（防 zip slip）：拒绝可逃逸 vault 根的条目名。
 * 目录条目（`/` 结尾）返回 false 表示跳过；不安全的名字直接抛错——
 * 整个归档不可信，不做「跳过坏条目继续导入」的半截处理。
 */
function assertSafeEntryName(name: string): void {
  if (
    name.startsWith("/") ||
    name.startsWith("\\") ||
    /^[a-zA-Z]:/.test(name) ||
    name.split("/").some((segment) => segment === "..")
  ) {
    throw new ZipReadError(`ZIP 条目路径不安全（已拒绝）：${name}`);
  }
}

/**
 * 解压 ZIP 字节流，返回全部文件条目（目录条目跳过）。
 * 输入不是合法 zip、结构截断、CRC 不匹配、含不安全路径或不支持的
 * 压缩方法时抛 ZipReadError。
 */
export async function readZipEntries(zip: Uint8Array): Promise<ZipReadEntry[]> {
  if (zip.length < EOCD_SIZE) {
    throw new ZipReadError("文件太小，不是合法的 ZIP 归档。");
  }
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

  // —— 定位 EOCD（从尾部回扫，跳过可能的 zip 注释） ——
  let eocdOffset = -1;
  const scanStart = Math.max(0, zip.length - EOCD_SCAN_WINDOW);
  for (let i = zip.length - EOCD_SIZE; i >= scanStart; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new ZipReadError("未找到 ZIP 结束记录（EOCD），文件可能已损坏。");
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  // 空归档（0 条目）时中央目录为空，centralOffset === eocdOffset 合法。
  if (centralOffset > eocdOffset) {
    throw new ZipReadError("ZIP 中央目录偏移越界，文件可能已损坏。");
  }

  // —— 解析 central directory ——
  interface CentralRecord {
    name: string;
    method: number;
    crc: number;
    compressedSize: number;
    uncompressedSize: number;
    localOffset: number;
  }
  const records: CentralRecord[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > zip.length ||
      view.getUint32(offset, true) !== CENTRAL_SIGNATURE
    ) {
      throw new ZipReadError("ZIP 中央目录损坏（签名或长度不符）。");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (offset + 46 + nameLength > zip.length) {
      throw new ZipReadError("ZIP 中央目录条目名越界，文件可能已损坏。");
    }
    const name = decoder.decode(
      zip.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (flags & FLAG_ENCRYPTED) {
      throw new ZipReadError(`不支持加密的 ZIP 条目：${name}`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ZipReadError(`不支持的 ZIP 压缩方法（${method}）：${name}`);
    }
    records.push({
      name,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  // —— 逐条目经 local header 定位数据并解压校验 ——
  const entries: ZipReadEntry[] = [];
  for (const record of records) {
    assertSafeEntryName(record.name);
    // 目录条目（名字以 `/` 结尾）：跳过，仅在需要时由调用方从名字推导。
    if (record.name.endsWith("/")) continue;
    const at = record.localOffset;
    if (at + 30 > zip.length || view.getUint32(at, true) !== LOCAL_SIGNATURE) {
      throw new ZipReadError(`ZIP 本地文件头损坏：${record.name}`);
    }
    const localNameLength = view.getUint16(at + 26, true);
    const localExtraLength = view.getUint16(at + 28, true);
    const dataStart = at + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + record.compressedSize;
    if (dataEnd > zip.length) {
      throw new ZipReadError(`ZIP 条目数据越界（文件被截断）：${record.name}`);
    }
    const raw = zip.slice(dataStart, dataEnd);
    const data = record.method === METHOD_STORED ? raw : await inflateRaw(raw);
    if (data.length !== record.uncompressedSize) {
      throw new ZipReadError(`ZIP 条目解压后大小不符：${record.name}`);
    }
    if (crc32(data) !== record.crc) {
      throw new ZipReadError(
        `ZIP 条目 CRC 校验失败（数据损坏）：${record.name}`,
      );
    }
    entries.push({ name: record.name, data });
  }
  return entries;
}

/** 把 ZipReadError 归一为领域错误（导入服务对外契约用）。 */
export function toZipDomainError(err: unknown): DomainError {
  if (err instanceof ZipReadError) {
    return new DomainError("INVALID_INPUT", err.message);
  }
  return new DomainError(
    "INVALID_INPUT",
    `读取 ZIP 归档失败：${err instanceof Error ? err.message : String(err)}`,
  );
}
