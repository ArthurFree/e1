/**
 * R006 阶段 1：note 组 IPC handler。
 * 本阶段全部为契约桩（NOT_IMPLEMENTED）——读取/创建/原子保存属
 * 阶段 2–4（Vault 扫描、MarkdownCodec、AtomicFileWriter + hash 乐观锁）。
 */
import { IPC_CHANNELS } from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import {
  parseCreateNoteInput,
  parseReadNoteInput,
  parseSaveNoteInput,
} from "../../../shared/ipc/schemas.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

function notImplemented(channel: string): never {
  throw new IpcFailure(
    "NOT_IMPLEMENTED",
    `${channel} 将在 R006 后续阶段实现（阶段 2–4）`,
  );
}

export function registerNoteHandlers(bus: IpcMainLike): void {
  bus.handle(
    IPC_CHANNELS.noteRead,
    handleRequest(parseReadNoteInput, () => notImplemented("note.read")),
  );
  bus.handle(
    IPC_CHANNELS.noteCreate,
    handleRequest(parseCreateNoteInput, () => notImplemented("note.create")),
  );
  bus.handle(
    IPC_CHANNELS.noteSave,
    handleRequest(parseSaveNoteInput, () => notImplemented("note.save")),
  );
}
