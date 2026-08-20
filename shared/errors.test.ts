/**
 * R006 阶段 1：IPC 统一错误码与线格式测试。
 * 覆盖：线格式形状守卫、任意抛出物归一、DomainError ↔ IPC 错误码映射往返。
 */
import { describe, expect, it } from "vitest";
import {
  decodeIpcBridgeError,
  DesktopIpcError,
  domainCodeFromIpc,
  encodeIpcBridgeError,
  IpcFailure,
  ipcErrorFromDomain,
  isIpcErrorPayload,
  toIpcErrorPayload,
} from "./errors.js";

describe("isIpcErrorPayload 线格式守卫", () => {
  it("接受 {code,message} 形状", () => {
    expect(isIpcErrorPayload({ code: "INVALID_INPUT", message: "坏" })).toBe(
      true,
    );
  });

  it("拒绝非对象/缺字段/错类型", () => {
    expect(isIpcErrorPayload(null)).toBe(false);
    expect(isIpcErrorPayload("INVALID_INPUT")).toBe(false);
    expect(isIpcErrorPayload({ code: "INVALID_INPUT" })).toBe(false);
    expect(isIpcErrorPayload({ code: 1, message: "x" })).toBe(false);
  });
});

describe("toIpcErrorPayload 异常归一", () => {
  it("IpcFailure 保留自身 code/message", () => {
    expect(toIpcErrorPayload(new IpcFailure("PATH_ESCAPE", "逃逸"))).toEqual({
      code: "PATH_ESCAPE",
      message: "逃逸",
    });
  });

  it("IpcFailure 的 details 透传进信封（FR-09 DOCUMENT_TOO_LARGE）", () => {
    expect(
      toIpcErrorPayload(
        new IpcFailure("DOCUMENT_TOO_LARGE", "过大", {
          sizeBytes: 11,
          maxBytes: 10,
        }),
      ),
    ).toEqual({
      code: "DOCUMENT_TOO_LARGE",
      message: "过大",
      details: { sizeBytes: 11, maxBytes: 10 },
    });
  });

  it("DomainError（鸭子类型）经映射表归一", () => {
    const domainError = {
      name: "DomainError",
      code: "WORKSPACE_NOT_FOUND",
      message: "知识库不存在",
    };
    expect(toIpcErrorPayload(domainError)).toEqual({
      code: "VAULT_NOT_FOUND",
      message: "知识库不存在",
    });
  });

  it("普通 Error 与未知值归一为 INTERNAL", () => {
    expect(toIpcErrorPayload(new Error("磁盘不可读"))).toEqual({
      code: "INTERNAL",
      message: "磁盘不可读",
    });
    expect(toIpcErrorPayload(42)).toEqual({
      code: "INTERNAL",
      message: "未知错误",
    });
  });
});

describe("DomainError ↔ IPC 错误码映射", () => {
  it("核心错误码往返一致", () => {
    // domain → ipc → domain 往返保持原码（映射子集内）。
    for (const [domainCode, ipcCode] of [
      ["INVALID_INPUT", "INVALID_INPUT"],
      ["DOCUMENT_CONFLICT", "DOCUMENT_CONFLICT"],
      ["WORKSPACE_NOT_FOUND", "VAULT_NOT_FOUND"],
      ["PAGE_NOT_FOUND", "NOTE_NOT_FOUND"],
    ] as const) {
      const payload = ipcErrorFromDomain({
        name: "DomainError",
        code: domainCode,
        message: "m",
      });
      expect(payload.code).toBe(ipcCode);
      expect(domainCodeFromIpc(payload.code)).toBe(domainCode);
    }
  });

  it("无 domain 语义的 IPC 码反向映射为 null", () => {
    expect(domainCodeFromIpc("NOT_IMPLEMENTED")).toBeNull();
    expect(domainCodeFromIpc("PATH_ESCAPE")).toBeNull();
    expect(domainCodeFromIpc("INTERNAL")).toBeNull();
  });

  it("R006-C3 笔记读取四码双向同名往返（批次 3 起 domain 有同名对应码）", () => {
    for (const code of [
      "NOTE_PERMISSION_DENIED",
      "NOTE_IO_ERROR",
      "DOCUMENT_TOO_LARGE",
      "UNSUPPORTED_ENCODING",
    ] as const) {
      const payload = ipcErrorFromDomain({
        name: "DomainError",
        code,
        message: "m",
      });
      expect(payload.code).toBe(code);
      expect(domainCodeFromIpc(payload.code)).toBe(code);
    }
  });

  it("未识别的 domain code 归一为 INTERNAL", () => {
    expect(
      ipcErrorFromDomain({
        name: "DomainError",
        code: "FUTURE_CODE",
        message: "m",
      }).code,
    ).toBe("INTERNAL");
  });
});

describe("DesktopIpcError", () => {
  it("携带稳定 code 且为 Error", () => {
    const err = new DesktopIpcError("NOTE_NOT_FOUND", "笔记不存在");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("NOTE_NOT_FOUND");
    expect(err.name).toBe("DesktopIpcError");
  });
});

describe("contextBridge 错误编解码", () => {
  it("编码后载荷完整存活于 message，可解码往返（含 details）", () => {
    const err = encodeIpcBridgeError({
      code: "DOCUMENT_CONFLICT",
      message: "磁盘版本不一致",
      details: { diskToken: "abc" },
    });
    // 模拟 contextBridge 重建：只保留 message 的 plain Error
    const rebuilt = new Error(err.message);
    const payload = decodeIpcBridgeError(rebuilt);
    expect(payload).toEqual({
      code: "DOCUMENT_CONFLICT",
      message: "磁盘版本不一致",
      details: { diskToken: "abc" },
    });
  });

  it("非桥编码错误与畸形载荷解码为 null", () => {
    expect(decodeIpcBridgeError(new Error("普通错误"))).toBeNull();
    expect(decodeIpcBridgeError("not an error")).toBeNull();
    expect(decodeIpcBridgeError(null)).toBeNull();
    expect(
      decodeIpcBridgeError(new Error("E1_IPC_ERROR:{invalid json")),
    ).toBeNull();
    expect(
      decodeIpcBridgeError(new Error('E1_IPC_ERROR:{"foo":1}')),
    ).toBeNull();
  });
});
