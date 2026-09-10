/**
 * R014：启动时查询 Vault 搬迁 journal 恢复状态。
 * 可自动恢复则 recover；manual-required 仅提示，不猜测删除源目录。
 */
import { useEffect, useRef } from "react";
import { useAppServices } from "../../state/AppServicesProvider";

export function VaultTransferRecoveryBridge() {
  const services = useAppServices();
  const transfer = services.vaultTransfer;
  const started = useRef(false);

  useEffect(() => {
    if (!transfer || started.current) return;
    started.current = true;
    void (async () => {
      try {
        const status = await transfer.getRecoveryStatus();
        if (status.phase === "clean") return;
        if (status.phase === "recoverable") {
          await transfer.recover();
          return;
        }
        services.assets.notify.notify(
          status.message ??
            "存在未完成的知识库搬迁，源目录未被自动删除，请确认后再处理。",
        );
      } catch (err) {
        console.warn("Vault 搬迁恢复检查失败", err);
      }
    })();
  }, [transfer, services.assets.notify]);

  return null;
}
