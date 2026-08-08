/**
 * 最小 ZIP writer 单测（R005 阶段 4，批次 4B）。
 *
 * 断言结构合法性（magic bytes / 条目名 / CRC32）与字节级确定性；
 * 「能被系统解压工具打开」的验证在开发时经 `unzip -l` 做过一次性确认
 *（见批次返回说明），不进自动化测试（避免依赖宿主机命令）。
 */
import { describe, expect, it } from "vitest";
import { crc32, createZip } from "./zip";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 从 ZIP 字节流解析 local file headers（STORED 专用测试辅助）。 */
function parseLocalEntries(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries: { name: string; crc: number; data: Uint8Array }[] = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const crc = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(
      zip.subarray(offset + 30, offset + 30 + nameLength),
    );
    const dataStart = offset + 30 + nameLength + extraLength;
    entries.push({
      name,
      crc,
      data: zip.subarray(dataStart, dataStart + size),
    });
    expect(flags).toBe(0x0800); // UTF-8 文件名 flag
    expect(method).toBe(0); // STORED
    offset = dataStart + size;
  }
  return entries;
}

describe("crc32", () => {
  it("标准测试向量「123456789」= 0xCBF43926", () => {
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
  });

  it("空输入 = 0", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("createZip", () => {
  it("magic bytes：local header 开头 + EOCD 结尾", () => {
    const zip = createZip([{ name: "a.md", data: encoder.encode("# 标题") }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50); // PK\x03\x04
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50); // PK\x05\x06
  });

  it("条目名（含中文/子目录）与内容字节完整往返，CRC 正确", () => {
    const md = encoder.encode("# 标题\n\n正文");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const zip = createZip([
      { name: "笔记.md", data: md },
      { name: "assets/图片 (2).png", data: png },
    ]);
    const entries = parseLocalEntries(zip);
    expect(entries.map((e) => e.name)).toEqual([
      "笔记.md",
      "assets/图片 (2).png",
    ]);
    expect([...entries[0].data]).toEqual([...md]);
    expect([...entries[1].data]).toEqual([...png]);
    expect(entries[0].crc).toBe(crc32(md));
    expect(entries[1].crc).toBe(crc32(png));
  });

  it("确定性：同一输入两次打包字节级一致", () => {
    const input = [
      { name: "a.md", data: encoder.encode("内容") },
      { name: "assets/f.bin", data: new Uint8Array([9, 8, 7]) },
    ];
    const first = createZip(input);
    const second = createZip(input);
    expect([...first]).toEqual([...second]);
  });

  it("central directory 计数与 EOCD 记录一致", () => {
    const zip = createZip([
      { name: "x", data: new Uint8Array([1]) },
      { name: "y", data: new Uint8Array([2]) },
      { name: "z", data: new Uint8Array([3]) },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = zip.length - 22;
    expect(view.getUint16(eocd + 8, true)).toBe(3);
    expect(view.getUint16(eocd + 10, true)).toBe(3);
    // central directory 起始偏移 + 大小 = EOCD 起点
    const centralSize = view.getUint32(eocd + 12, true);
    const centralStart = view.getUint32(eocd + 16, true);
    expect(centralStart + centralSize).toBe(eocd);
    expect(view.getUint32(centralStart, true)).toBe(0x02014b50); // PK\x01\x02
  });
});
