/**
 * NatStack Panel Manager — Options Page (Firefox)
 *
 * Configures server URL, management token, and preferences.
 * Uses browser.* APIs (Firefox WebExtensions).
 */

const serverUrlInput = document.getElementById("serverUrl");
const managementTokenInput = document.getElementById("managementToken");
const autoOpenTabs = document.getElementById("autoOpenTabs");
const autoCloseTabs = document.getElementById("autoCloseTabs");
const saveBtn = document.getElementById("saveBtn");
const savedMsg = document.getElementById("savedMsg");

// Load saved config
browser.storage.local.get(
  ["serverUrl", "managementToken", "autoOpenTabs", "autoCloseTabs"],
).then((result) => {
  serverUrlInput.value = result.serverUrl || "";
  managementTokenInput.value = result.managementToken || "";
  autoOpenTabs.checked = result.autoOpenTabs !== false;
  autoCloseTabs.checked = result.autoCloseTabs !== false;
});

// Save
saveBtn.addEventListener("click", () => {
  const config = {
    serverUrl: serverUrlInput.value.replace(/\/+$/, ""),
    managementToken: managementTokenInput.value.trim(),
    autoOpenTabs: autoOpenTabs.checked,
    autoCloseTabs: autoCloseTabs.checked,
  };

  browser.storage.local.set(config).then(() => {
    savedMsg.classList.add("show");
    setTimeout(() => savedMsg.classList.remove("show"), 1500);
  });
});
