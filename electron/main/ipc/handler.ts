/**
 * R006 阶段 1：Main 侧 IPC handler 统一包装。
 *
 * 每个 handler 的处理管线：schema 校验（shared/ipc/schemas）→ 业务分发 →
 * 异常归一为 {code,message} 线格式（shared/errors）。
 * handler 永不 throw——Electron 对 ipcMain.handle 抛出的错误序列化不可靠
 * （message 会被加 "Error invoking remote method" 前缀且丢失结构），
 * 一律返回 IpcResult 信封，由 preload 解包/拒签。
 */
import type { IpcResult } from "../../../shared/ipc/contracts.js";
import {
  toIpcErrorPayload,
  type IpcErrorPayload,
} from "../../../shared/errors.js";

/** ipcMain 的最小结构视图（测试可注入 mock）。 */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload: unknown) => unknown,
  ): void;
}

export function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

export function fail<T>(error: IpcErrorPayload): IpcResult<T> {
  return { ok: false, error };
}

/**
 * 包装一个 IPC handler：parse 校验入参（失败抛 IpcFailure），fn 为业务
 * 实现；任何抛出物归一为 fail 信封。
 */
export function handleRequest<TReq, TRes>(
  parse: (payload: unknown) => TReq,
  fn: (request: TReq) => TRes | Promise<TRes>,
): (event: unknown, payload: unknown) => Promise<IpcResult<TRes>> {
  return async (_event, payload) => {
    try {
      return ok(await fn(parse(payload)));
    } catch (error) {
      return fail(toIpcErrorPayload(error));
    }
  };
}
