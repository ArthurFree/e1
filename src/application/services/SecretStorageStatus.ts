/**
 * 机密存储运行状态（R008 Stage 1 §8.6，R8-02）：平台无关的 secret
 * persistence mode 表达，与能力字段分离——
 *
 *   RuntimeCapabilities.nativeSecrets
 *   = Runtime 是否接入了系统安全存储集成（静态）；
 *
 *   SecretStorageStatus.mode
 *   = 这台机器当前实际的安全后端状态（运行时探测）。
 *
 * 线格式与 shared/ipc/contracts 的 SecretStorageStatus 同构（wire 契约），
 * 本文件是 application/components 消费的平台无关视图（R8-04 同口径：
 * 应用层不依赖 Electron 类型）。
 */
export type {
  SecretStorageMode,
  SecretStorageStatus,
} from "../../../shared/ipc/contracts";
