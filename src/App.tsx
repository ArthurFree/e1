import { AppProviders } from "./state/AppProviders";
import { AppShell } from "./components/AppShell";
import { ExternalVaultChangeBridge } from "./components/shell/ExternalVaultChangeBridge";
import { VaultTransferRecoveryBridge } from "./components/shell/VaultTransferRecoveryBridge";

export default function App() {
  return (
    <AppProviders>
      {/* R007 阶段 3：外部 Vault 变更 → 页面树刷新桥（fileWatching 能力门控） */}
      <ExternalVaultChangeBridge />
      <VaultTransferRecoveryBridge />
      <AppShell />
    </AppProviders>
  );
}
