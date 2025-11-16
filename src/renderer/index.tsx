import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";

import { PanelApp } from "./components/PanelApp";

async function initializeApp(): Promise<void> {
  try {
    const appInfo = await window.electronAPI.getAppInfo();
    console.log("NatStack version:", appInfo.version);

    const container = document.getElementById("app");
    if (!container) {
      console.error("Renderer root not found");
      return;
    }

    const root = createRoot(container);
    root.render(
      <StrictMode>
        <PanelApp />
      </StrictMode>
    );
  } catch (error) {
    console.error("Failed to initialize app:", error);
  }
}

void initializeApp();
