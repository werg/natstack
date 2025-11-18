import panelAPI from "natstack/panel";

// Example panel demonstrating the panel API

console.log("Panel script loaded for", panelAPI.getId());

const launchChildButton = document.getElementById("launch-child") as HTMLButtonElement;
const setTitleButton = document.getElementById("set-title") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;

function showStatus(message: string, type: "success" | "error" | "info" = "info") {
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
  setTimeout(() => {
    statusDiv.textContent = "";
    statusDiv.className = "status";
  }, 3000);
}

// Launch a child panel
launchChildButton.addEventListener("click", async () => {
  try {
    showStatus("Creating child panel...", "info");
    const childId = await panelAPI.createChild("panels/example");
    showStatus(`Child panel created with ID: ${childId}`, "success");
  } catch (error) {
    showStatus(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
});

// Set a random title
setTitleButton.addEventListener("click", async () => {
  try {
    const titles = [
      "Example Panel",
      "My Custom Panel",
      "Panel " + Math.floor(Math.random() * 1000),
      "Updated Panel",
      "Test Panel",
    ];
    const randomTitle = titles[Math.floor(Math.random() * titles.length)] || "Panel";

    await panelAPI.setTitle(randomTitle);
    showStatus(`Title changed to: ${randomTitle}`, "success");
  } catch (error) {
    showStatus(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
});

// Set initial title
panelAPI
  .setTitle("Example Panel")
  .then(() => console.log("Initial title set"))
  .catch(console.error);

// Listen for focus events
const unsubscribeFocus = panelAPI.onFocus(() => {
  console.log("Panel received focus");
});

// Listen for child removal events
const unsubscribeChildRemoved = panelAPI.onChildRemoved((childId) => {
  console.log(`Child panel removed: ${childId}`);
  showStatus(`Child panel ${childId} was removed`, "info");
});

// Cleanup on unload
window.addEventListener("beforeunload", () => {
  unsubscribeFocus();
  unsubscribeChildRemoved();
});
