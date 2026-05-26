import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { createNotificationService } from "./notificationService.js";

function createHarness(capabilities: string[] = []) {
  const eventService = { emit: vi.fn() };
  const viewManager = {
    getViewInfo: vi.fn(() => ({
      type: "app",
      visible: true,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      capabilities,
    })),
  };
  const service = createNotificationService({
    eventService: eventService as never,
    getViewManager: () => viewManager as never,
  });
  return { service, eventService };
}

describe("createNotificationService", () => {
  it("gates app notification calls on the notifications capability", async () => {
    const { service } = createHarness([]);

    await expect(
      service.handler({ caller: createVerifiedCaller("@workspace-apps/shell", "app") }, "show", [
        { type: "info", title: "Denied" },
      ])
    ).rejects.toThrow(/requires app capability 'notifications'/);
  });

  it("emits notification events for apps with the notifications capability", async () => {
    const { service, eventService } = createHarness(["notifications"]);

    const id = await service.handler(
      { caller: createVerifiedCaller("@workspace-apps/shell", "app") },
      "show",
      [{ type: "info", title: "Allowed" }]
    );

    expect(id).toMatch(/^notif-/);
    expect(eventService.emit).toHaveBeenCalledWith("notification:show", {
      id,
      type: "info",
      title: "Allowed",
    });
  });

  it("preserves typed notification action commands", async () => {
    const { service, eventService } = createHarness(["notifications"]);

    await service.handler(
      { caller: createVerifiedCaller("@workspace-apps/shell", "app") },
      "show",
      [
        {
          type: "info",
          title: "Update",
          actions: [
            {
              id: "app.applyUpdate",
              label: "Load update",
              command: { type: "app.applyUpdate", appId: "@workspace-apps/shell" },
            },
          ],
        },
      ]
    );

    expect(eventService.emit).toHaveBeenCalledWith(
      "notification:show",
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            command: { type: "app.applyUpdate", appId: "@workspace-apps/shell" },
          }),
        ],
      })
    );
  });
});
