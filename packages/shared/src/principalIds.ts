export const PANEL_PRINCIPAL_PREFIX = "panel:";

export function panelPrincipalId(panelTreeId: string): string {
  if (panelTreeId.startsWith(PANEL_PRINCIPAL_PREFIX)) {
    throw new Error(`Panel tree ID must not already include ${PANEL_PRINCIPAL_PREFIX}: ${panelTreeId}`);
  }
  return `${PANEL_PRINCIPAL_PREFIX}${panelTreeId}`;
}

export function assertPanelPrincipalId(panelId: string): void {
  if (!panelId.startsWith(PANEL_PRINCIPAL_PREFIX)) {
    throw new Error(`Panel ID must be canonical and start with ${PANEL_PRINCIPAL_PREFIX}: ${panelId}`);
  }
}
