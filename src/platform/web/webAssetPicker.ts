/**
 * Web 文件选择器（R005 阶段 5）：<input type=file> 的浏览器 DOM 交互
 * 收在本适配层，编辑器不再创建文件输入框。
 * 用户取消（cancel 事件）resolve null；选中后读出字节返回 PickedAsset。
 * Desktop 未来以 Electron Main 原生对话框替换本实现。
 */
import type {
  AssetPicker,
  AssetPickOptions,
  PickedAsset,
} from "../../application/assets/assetServices";

export class WebAssetPicker implements AssetPicker {
  pick(options?: AssetPickOptions): Promise<PickedAsset | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      if (options?.accept) input.accept = options.accept;
      // 挂到 DOM：部分浏览器要求 input 在文档内才能弹出选择框。
      input.style.display = "none";
      document.body.append(input);
      const finish = (picked: PickedAsset | null) => {
        input.remove();
        resolve(picked);
      };
      input.addEventListener("cancel", () => finish(null));
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) {
          finish(null);
          return;
        }
        void file
          .arrayBuffer()
          .then((buffer) =>
            finish({
              name: file.name,
              mimeType: file.type,
              size: file.size,
              source: { kind: "bytes", data: new Uint8Array(buffer) },
            }),
          )
          .catch(() => finish(null));
      });
      input.click();
    });
  }
}
