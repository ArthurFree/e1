/**
 * ZIP reader 测试（R005 阶段 7，批次 7B）。
 *
 * 覆盖：
 * - 与 4B writer 的往返（STORED 条目字节一致、目录条目跳过、中文名 UTF-8）；
 * - Deflate 条目解压（测试内用手工构造的 deflate zip，Node zlib 生成
 *   deflate-raw 字节，模拟第三方工具产出的压缩归档）；
 * - 坏 CRC / 截断文件 / 非 zip 输入 / 不支持的压缩方法 → 拒绝；
 * - 路径安全（zip slip）：`..`、绝对路径、盘符条目名 → 拒绝。
 */
import { describe, expect, it } from "vitest";
import { crc32, createZip } from "./zip";
import { readZipEntries, ZipReadError } from "./zipReader";

const encoder = new TextEncoder();

/** 经 CompressionStream 生成 deflate-raw 字节（与 reader 侧对称的 Web API）。 */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  // 同 zipReader：DOM 泛型下 writable 为 BufferSource，收窄一次类型。
  const transform = new CompressionStream(
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

/** 测试用最小 zip 构造器：支持 STORED 与 Deflate（writer 只产 STORED）。 */
async function buildZip(
  entries: { name: string; data: Uint8Array; method?: 0 | 8 }[],
): Promise<Uint8Array> {
  interface EncodedEntry {
    nameBytes: Uint8Array;
    method: 0 | 8;
    crc: number;
    compressed: Uint8Array;
    uncompressedSize: number;
  }
  const encoded: EncodedEntry[] = [];
  for (const entry of entries) {
    const method = entry.method ?? 0;
    const compressed = method === 8 ? await deflateRaw(entry.data) : entry.data;
    encoded.push({
      nameBytes: encoder.encode(entry.name),
      method,
      crc: crc32(entry.data),
      compressed,
      uncompressedSize: entry.data.length,
    });
  }

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const header = (size: number) => {
    const buf = new Uint8Array(size);
    return { buf, view: new DataView(buf.buffer) };
  };

  for (const entry of encoded) {
    const { buf, view } = header(30);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true); // EFS：文件名 UTF-8
    view.setUint16(8, entry.method, true);
    view.setUint16(12, 0x21, true); // DOS date
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.compressed.length, true);
    view.setUint32(22, entry.uncompressedSize, true);
    view.setUint16(26, entry.nameBytes.length, true);
    central.push(buildCentral(entry, offset));
    parts.push(buf, entry.nameBytes, entry.compressed);
    offset += 30 + entry.nameBytes.length + entry.compressed.length;
  }

  const centralStart = offset;
  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const { buf: eocd, view: eocdView } = header(22);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, encoded.length, true);
  eocdView.setUint16(10, encoded.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralStart, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...parts, ...central, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;

  function buildCentral(
    entry: (typeof encoded)[number],
    localOffset: number,
  ): Uint8Array {
    const { buf, view } = header(46);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, entry.method, true);
    view.setUint16(14, 0x21, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.compressed.length, true);
    view.setUint32(24, entry.uncompressedSize, true);
    view.setUint16(28, entry.nameBytes.length, true);
    view.setUint32(42, localOffset, true);
    const out = new Uint8Array(46 + entry.nameBytes.length);
    out.set(buf, 0);
    out.set(entry.nameBytes, 46);
    return out;
  }
}

describe("readZipEntries", () => {
  it("与 writer 往返：STORED 条目字节一致，目录条目跳过", async () => {
    const zip = createZip([
      { name: "manifest.json", data: encoder.encode('{"format":"e1-vault"}') },
      { name: "notes/工作/", data: new Uint8Array(0) },
      { name: "notes/工作/项目 A.md", data: encoder.encode("# 你好\n") },
      { name: "assets/图.png", data: new Uint8Array([1, 2, 3, 250]) },
    ]);
    const entries = await readZipEntries(zip);
    const byName = new Map(entries.map((e) => [e.name, e.data]));

    // 目录条目 notes/工作/ 不返回。
    expect(entries.map((e) => e.name).sort()).toEqual(
      ["assets/图.png", "manifest.json", "notes/工作/项目 A.md"].sort(),
    );
    expect(new TextDecoder().decode(byName.get("manifest.json"))).toBe(
      '{"format":"e1-vault"}',
    );
    expect(new TextDecoder().decode(byName.get("notes/工作/项目 A.md"))).toBe(
      "# 你好\n",
    );
    expect([...byName.get("assets/图.png")!]).toEqual([1, 2, 3, 250]);
  });

  it("Deflate 条目正确解压（含中文名与中文内容）", async () => {
    const body = encoder.encode("你好 vault，重复内容。".repeat(200));
    const zip = await buildZip([
      { name: "notes/学习/React.md", data: body, method: 8 },
      { name: "manifest.json", data: encoder.encode("{}"), method: 0 },
    ]);
    const entries = await readZipEntries(zip);
    const byName = new Map(entries.map((e) => [e.name, e.data]));
    expect(new TextDecoder().decode(byName.get("notes/学习/React.md"))).toBe(
      new TextDecoder().decode(body),
    );
    expect(new TextDecoder().decode(byName.get("manifest.json"))).toBe("{}");
  });

  it("空 zip（0 条目）返回空数组", async () => {
    expect(await readZipEntries(createZip([]))).toEqual([]);
  });

  it("数据被篡改 → CRC 校验失败拒绝", async () => {
    const zip = createZip([{ name: "a.md", data: encoder.encode("原始内容") }]);
    // 翻转数据区一个字节（local header 30 + 名字长 4 之后）。
    zip[30 + 4 + 2] ^= 0xff;
    await expect(readZipEntries(zip)).rejects.toThrow(/CRC/);
  });

  it("文件截断 → 拒绝", async () => {
    const zip = createZip([
      { name: "a.md", data: encoder.encode("一些内容") },
      { name: "b.md", data: encoder.encode("另一些内容") },
    ]);
    await expect(readZipEntries(zip.slice(0, zip.length - 10))).rejects.toThrow(
      ZipReadError,
    );
  });

  it("非 zip 输入 → 拒绝", async () => {
    await expect(
      readZipEntries(encoder.encode("这不是 zip 文件，只是一些文本……")),
    ).rejects.toThrow(ZipReadError);
  });

  it("不支持的压缩方法 → 拒绝", async () => {
    const zip = await buildZip([{ name: "a.md", data: encoder.encode("x") }]);
    // 把 central 与 local header 的压缩方法改成 9（不存在的 deflate64）。
    const view = new DataView(zip.buffer);
    view.setUint16(8, 9, true); // local header method
    const centralOffset = zip.length - 22 - (46 + 4);
    view.setUint16(centralOffset + 10, 9, true);
    await expect(readZipEntries(zip)).rejects.toThrow(/压缩方法/);
  });

  it.each([
    ["../evil.md"],
    ["notes/../../evil.md"],
    ["/abs/evil.md"],
    ["C:/evil.md"],
  ])("zip slip 条目名 %j → 拒绝", async (name) => {
    const zip = await buildZip([{ name, data: encoder.encode("evil") }]);
    await expect(readZipEntries(zip)).rejects.toThrow(/路径不安全/);
  });
});
