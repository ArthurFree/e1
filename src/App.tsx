import { AppProviders } from "./state/AppProviders";
import { AppShell } from "./components/AppShell";

export default function App() {
  return (
    <AppProviders>
      <AppShell />
    </AppProviders>
  );
}
