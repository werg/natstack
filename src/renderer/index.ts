async function initializeApp(): Promise<void> {
  try {
    // Get app info from main process
    const appInfo = await window.electronAPI.getAppInfo();
    console.log("App version:", appInfo.version);

    // Initialize UI
    initializeUI();
  } catch (error) {
    console.error("Failed to initialize app:", error);
  }
}

function initializeUI(): void {
  const appContainer = document.getElementById("app");
  if (!appContainer) {
    console.error("App container not found");
    return;
  }

  // Make divider draggable for panel resizing
  const divider = document.querySelector(".divider");
  if (!(divider instanceof HTMLElement)) {
    console.error("Divider element not found");
    return;
  }

  let isResizing = false;

  divider.addEventListener("mousedown", (): void => {
    isResizing = true;
  });

  document.addEventListener("mousemove", (event: MouseEvent): void => {
    if (!isResizing) {
      return;
    }

    const leftPanel = document.querySelector(".panel-left");
    const rightPanel = document.querySelector(".panel-right");

    if (!(leftPanel instanceof HTMLElement) || !(rightPanel instanceof HTMLElement)) {
      return;
    }

    const containerRect = appContainer.getBoundingClientRect();
    const newLeftWidth = event.clientX - containerRect.left;

    if (newLeftWidth > 100 && newLeftWidth < containerRect.width - 100) {
      leftPanel.style.flex = `0 0 ${newLeftWidth}px`;
      rightPanel.style.flex = "1";
    }
  });

  document.addEventListener("mouseup", (): void => {
    isResizing = false;
  });

  console.log("UI initialized successfully");
}

void initializeApp();
