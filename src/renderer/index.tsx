import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";

import { PanelApp } from "./components/PanelApp";

async function initializeApp(): Promise<void> {
  try {
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
    // Show error in DOM
    const container = document.getElementById("app");
    if (container) {
      container.innerHTML = `<div style="color: red; padding: 20px; font-family: monospace;">
        <h2>Failed to initialize app</h2>
        <pre>${error instanceof Error ? error.message : String(error)}</pre>
        <pre>${error instanceof Error ? error.stack : ''}</pre>
      </div>`;
    }
  }
}

void initializeApp();
