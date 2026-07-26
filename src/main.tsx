import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppServicesProvider } from "./state/AppServicesProvider";
import { createBrowserAppServices } from "./infrastructure/browserServices";
import "./styles/index.css";
import "katex/dist/katex.min.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <AppServicesProvider services={createBrowserAppServices()}>
      <App />
    </AppServicesProvider>
  </StrictMode>,
);
