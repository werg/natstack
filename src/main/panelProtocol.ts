import { protocol } from "electron";

/**
 * Register privileged custom protocol schemes.
 * Must be called before app.ready.
 *
 * These are navigation-only protocols (intercepted in will-navigate,
 * never used for content serving):
 *   ns://        - Panel navigation
 *   ns-about://  - About page navigation
 *   ns-focus://  - Focus panel navigation
 */
export function registerPanelProtocol(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "ns",
      privileges: {
        standard: true,
        secure: true,
      },
    },
    {
      scheme: "ns-about",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
    {
      scheme: "ns-focus",
      privileges: {
        standard: true,
        secure: true,
      },
    },
  ]);
}
