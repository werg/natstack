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
    const container = document.getElementById("app");
    if (container) {
      container.textContent = "";
      const wrapper = document.createElement("div");
      wrapper.style.cssText = "color: red; padding: 20px; font-family: monospace;";
      const heading = document.createElement("h2");
      heading.textContent = "Failed to initialize app";
      const msg = document.createElement("pre");
      msg.textContent = error instanceof Error ? error.message : String(error);
      const stack = document.createElement("pre");
      stack.textContent = error instanceof Error ? (error.stack ?? "") : "";
      wrapper.append(heading, msg, stack);
      container.appendChild(wrapper);
    }
  }
}

void initializeApp();
