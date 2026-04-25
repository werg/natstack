import { describe, expect, it, vi } from "vitest";

import { registerManifestWebhooks } from "./webhooks.js";

const googleWorkspaceProvider = {
  id: "google-workspace",
  displayName: "Google Workspace",
  apiBase: ["https://gmail.googleapis.com"],
  flows: [],
};

describe("registerManifestWebhooks", () => {
  it("exposes and subscribes manifest-declared webhook handlers", async () => {
    const exposeMethod = vi.fn();
    const subscribeWebhook = vi.fn(async () => ({
      subscriptionId: "sub-1",
      leaseId: "lease-1",
    }));

    const registrations = await registerManifestWebhooks(
      {
        exposeMethod,
        credentials: {
          connect: vi.fn(),
          listConnections: vi.fn(),
          revokeConsent: vi.fn(),
          subscribeWebhook,
          unsubscribeWebhook: vi.fn(),
          listWebhookLeases: vi.fn(),
        },
      } as any,
      {
        gmail: {
          manifest: {
            providers: [googleWorkspaceProvider],
            scopes: { "google-workspace": ["gmail_readonly"] },
            endpoints: {},
            webhooks: {
              "google-workspace": [
                { event: "message.new", deliver: "onNewMessage" },
              ],
            },
          },
          onNewMessage: vi.fn(),
        },
      },
    );

    expect(registrations).toEqual([
      expect.objectContaining({
        moduleName: "gmail",
        providerId: "google-workspace",
        eventType: "message.new",
        subscriptionId: "sub-1",
        leaseId: "lease-1",
      }),
    ]);
    expect(exposeMethod).toHaveBeenCalledWith(
      expect.stringContaining("__webhook__.gmail"),
      expect.any(Function),
    );
    expect(subscribeWebhook).toHaveBeenCalledWith(googleWorkspaceProvider, "message.new", {
      connectionId: undefined,
      handler: expect.stringContaining("__webhook__.gmail"),
    });
  });
});
