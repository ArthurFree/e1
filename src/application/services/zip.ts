/**
 * 最小 ZIP writer（R005 阶段 4，批次 4B）。
 *
 * 不引入第三方依赖：只支持 STORED（无压缩）条目，足以承载
 * 「Markdown + assets/」的导出包。生成标准 ZIP 容器——local file
 * header + central directory + EOCD，文件名按 UTF-8 编码并置
 * general purpose flag 第 11 位（EFS），macOS Finder / unzip / ditto
 * 均可直接打开。
 *
 * 确定性：条目时间戳固定为 1980-01-01 00:00:00（DOS 时间最小合法值），
 * 同一输入多次打包产出字节级一致的结果（与 portable-vault.md
 * 「同一输入多次导出必须产生确定性路径」的要求一致）。
 */

/** CRC32 查找表（多项式 0xEDB88320，与 ZIP 规格一致）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** 计算 CRC32（ZIP 条目完整性校验值）。 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  /** 条目名（UTF-8；目录用 `/` 分隔，如 `assets/图片.png`）。 */
  name: string;
  data: Uint8Array;
}

const encoder = new TextEncoder();

// 固定 DOS 时间戳：1980-01-01 00:00:00（time=0，date=(0<<9)|(1<<5)|1）。
const DOS_TIME = 0;
const DOS_DATE = 0x21;
// general purpose flag：第 11 位 = 文件名 UTF-8 编码（EFS）。
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

/**
 * 打包为 ZIP 字节流。条目按传入顺序写入。
 * 单条目或总大小超过 4GB（ZIP64 未实现）时抛错——导出场景远低于此。
 */
export function createZip(entries: ZipEntryInput[]): Uint8Array {
  const encoded = entries.map((entry) => ({
    nameBytes: encoder.encode(entry.name),
    data: entry.data,
    crc: crc32(entry.data),
  }));

  let total = EOCD_SIZE;
  for (const entry of encoded) {
    total +=
      LOCAL_HEADER_SIZE +
      entry.nameBytes.length +
      entry.data.length +
      CENTRAL_HEADER_SIZE +
      entry.nameBytes.length;
  }
  if (total > 0xffffffff) {
    throw new Error("导出内容超过 ZIP 格式上限（4GB）。");
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  // 记录每个条目的 local header 偏移，供 central directory 回填。
  const localOffsets: number[] = [];

  // —— local file headers + 数据 ——
  for (const entry of encoded) {
    localOffsets.push(offset);
    view.setUint32(offset, 0x04034b50, true); // local file header 签名
    view.setUint16(offset + 4, 20, true); // 解压所需版本 2.0
    view.setUint16(offset + 6, FLAG_UTF8, true);
    view.setUint16(offset + 8, METHOD_STORED, true);
    view.setUint16(offset + 10, DOS_TIME, true);
    view.setUint16(offset + 12, DOS_DATE, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.data.length, true); // 压缩后大小（STORED = 原始）
    view.setUint32(offset + 22, entry.data.length, true); // 原始大小
    view.setUint16(offset + 26, entry.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true); // extra 长度
    offset += LOCAL_HEADER_SIZE;
    out.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
    out.set(entry.data, offset);
    offset += entry.data.length;
  }

  // —— central directory ——
  const centralStart = offset;
  encoded.forEach((entry, index) => {
    view.setUint32(offset, 0x02014b50, true); // central header 签名
    view.setUint16(offset + 4, 20, true); // 创建版本
    view.setUint16(offset + 6, 20, true); // 解压所需版本
    view.setUint16(offset + 8, FLAG_UTF8, true);
    view.setUint16(offset + 10, METHOD_STORED, true);
    view.setUint16(offset + 12, DOS_TIME, true);
    view.setUint16(offset + 14, DOS_DATE, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.nameBytes.length, true);
    // extra / comment / disk / 内部属性 全部 0（offset+30..39）
    view.setUint32(offset + 38, 0, true); // 外部属性
    view.setUint32(offset + 42, localOffsets[index], true);
    offset += CENTRAL_HEADER_SIZE;
    out.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
  });
  const centralSize = offset - centralStart;

  // —— end of central directory ——
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true); // 本磁盘号
  view.setUint16(offset + 6, 0, true); // central directory 起始磁盘
  view.setUint16(offset + 8, encoded.length, true);
  view.setUint16(offset + 10, encoded.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true); // 注释长度

  return out;
}
