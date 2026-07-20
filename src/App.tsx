import { AppProvider } from "./state/AppState";
import { AppShell } from "./components/AppShell";

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
