import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider as JotaiProvider } from "jotai";
import "@radix-ui/themes/styles.css";
import "./styles/overrides.css";

import { App } from "./components/App";

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
        <JotaiProvider>
          <App />
        </JotaiProvider>
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
        <pre>${error instanceof Error ? error.stack : ""}</pre>
      </div>`;
    }
  }
}

void initializeApp();
