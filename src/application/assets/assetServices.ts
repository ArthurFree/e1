/**
 * 附件与资源访问服务接口（R005 阶段 5，规格 r005.md §十）。
 *
 * 把浏览器专属行为（文件选择、Object URL、a[download] 下载、alert 反馈）
 * 从编辑器 NodeView 中移出，收口为四个平台可替换的接口/服务：
 * - AssetCommandService：导入/删除编排（平台无关类，见 ./AssetCommandService）；
 * - AssetAccessService：二进制读取、临时 URL 解析与下载（Web 实现见
 *   platform/web/webAssetAccess.ts，内存实现见 infrastructure/memory）；
 * - AssetPicker：文件选择（Web 实现为 <input type=file>）；
 * - NotificationService：校验/错误反馈通道（Web 实现暂为 window.alert，
 *   后续可替换为 toast）。
 *
 * 编辑器扩展只经 editor.storage.assetServices 消费本组接口；
 * domain 实体与 port 均不出现 Blob（见 domain/repositories.ts 的 AssetStore）。
 */
import type { Attachment, BinaryAttachment } from "../../domain/types";
import type { AssetCommandService } from "./AssetCommandService";

/** 资源读取与平台相关访问能力。 */
export interface AssetAccessService {
  getMetadata(assetId: string): Promise<Attachment | undefined>;
  getBinary(assetId: string): Promise<BinaryAttachment | undefined>;
  listByDocument(pageId: string): Promise<Attachment[]>;
  /**
   * 解析为可渲染的临时 URL（Web：Object URL）；资源缺失/为空/环境不支持
   * 时返回 null。调用方负责在不再需要时 releaseUrl 释放。
   */
  resolveUrl(assetId: string): Promise<string | null>;
  /** 释放 resolveUrl 产出的 URL（Web：revokeObjectURL）。 */
  releaseUrl(url: string): void;
  /**
   * 触发资源下载（Web：a[download]）。
   * @returns false 表示资源缺失或为空（调用方展示「附件不可用」）。
   */
  download(assetId: string): Promise<boolean>;
}

/** 文件选择选项。 */
export interface AssetPickOptions {
  /** 可接受的 MIME 列表（对应 input accept；缺省不限）。 */
  accept?: string;
}

/** 用户选中的文件（字节已读出）。 */
export interface PickedAsset {
  name: string;
  mimeType: string;
  size: number;
  data: Uint8Array;
}

/** 文件选择器；用户取消时 resolve null。 */
export interface AssetPicker {
  pick(options?: AssetPickOptions): Promise<PickedAsset | null>;
}

/** 用户反馈通道（校验失败/写入失败等即时提示）。 */
export interface NotificationService {
  notify(message: string): void;
}

/**
 * 编辑器与组件消费的资源服务组（AppServices.assets 与
 * editor.storage.assetServices 共用同一形状）。
 */
export interface AssetServices {
  commands: AssetCommandService;
  access: AssetAccessService;
  picker: AssetPicker;
  notify: NotificationService;
}
