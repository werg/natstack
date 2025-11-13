/**
 * NatStack - Agentic Panel Platform
 * Main renderer initialization
 */

import { PanelManager } from './components/PanelManager';

let panelManager: PanelManager | null = null;

async function initializeApp(): Promise<void> {
  try {
    // Get app info from main process
    const appInfo = await window.electronAPI.getAppInfo();
    console.log('NatStack version:', appInfo.version);

    // Initialize panel system
    initializePanelSystem();
  } catch (error) {
    console.error('Failed to initialize app:', error);
  }
}

function initializePanelSystem(): void {
  // Get panel container
  const container = document.getElementById('panel-container');
  if (!container) {
    console.error('Panel container not found');
    return;
  }

  // Initialize PanelManager with default max visible panels
  panelManager = new PanelManager(container, 3);

  // Set up controls
  setupControls();

  console.log('Panel system initialized successfully');

  // Log initial state for debugging
  console.log('Initial state:', panelManager.getState());
}

function setupControls(): void {
  if (!panelManager) return;

  const decreaseButton = document.getElementById('decrease-panels');
  const increaseButton = document.getElementById('increase-panels');
  const countDisplay = document.getElementById('panel-count');

  if (!decreaseButton || !increaseButton || !countDisplay) {
    console.error('Control elements not found');
    return;
  }

  let currentMax = 3;

  decreaseButton.addEventListener('click', () => {
    if (currentMax > 1) {
      currentMax--;
      panelManager?.setMaxVisiblePanels(currentMax);
      countDisplay.textContent = currentMax.toString();
    }
  });

  increaseButton.addEventListener('click', () => {
    if (currentMax < 6) {
      currentMax++;
      panelManager?.setMaxVisiblePanels(currentMax);
      countDisplay.textContent = currentMax.toString();
    }
  });
}

// Initialize the app when DOM is ready
void initializeApp();
