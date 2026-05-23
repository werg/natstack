import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_CATEGORY_DECIDE } from "@natstack/shared/approvalContract";
import { createPushMetrics } from "./pushMetrics.js";
import { __private__, createPushService } from "./pushService.js";

const { buildFirebaseMessage } = __private__;
const DECISION_ACTIONS_JSON = JSON.stringify([
  { id: "once", title: "Once" },
  { id: "deny", title: "Deny" },
]);

function tempRegistrationsPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "natstack-push-")), "registrations.json");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pushService", () => {
  it("builds Android data-only approval payloads", () => {
    const message = buildFirebaseMessage(
      {
        clientId: "android-1",
        platform: "android",
        token: "token-1",
        registeredAt: 1,
      },
      {
        title: "Approve request",
        body: "Worker wants access",
        category: APPROVAL_CATEGORY_DECIDE,
        data: {
          kind: "approval-prompt",
          approvalId: "approval-1",
          category: APPROVAL_CATEGORY_DECIDE,
          actionsJson: DECISION_ACTIONS_JSON,
        },
      }
    );

    expect(message).toMatchObject({
      token: "token-1",
      android: { priority: "high" },
      data: {
        kind: "approval-prompt",
        approvalId: "approval-1",
        title: "Approve request",
        body: "Worker wants access",
        category: APPROVAL_CATEGORY_DECIDE,
        actionsJson: DECISION_ACTIONS_JSON,
      },
    });
    expect(message).not.toHaveProperty("notification");
  });

  it("builds iOS notification payloads with APNs category", () => {
    const message = buildFirebaseMessage(
      {
        clientId: "ios-1",
        platform: "ios",
        token: "token-2",
        registeredAt: 1,
      },
      {
        title: "Approve request",
        body: "Panel wants access",
        category: APPROVAL_CATEGORY_DECIDE,
        data: {
          kind: "approval-prompt",
          approvalId: "approval-2",
          category: APPROVAL_CATEGORY_DECIDE,
        },
      }
    );

    expect(message).toMatchObject({
      token: "token-2",
      notification: {
        title: "Approve request",
        body: "Panel wants access",
      },
      apns: {
        headers: {
          "apns-push-type": "alert",
          "apns-priority": "10",
        },
        payload: {
          aps: {
            category: APPROVAL_CATEGORY_DECIDE,
            "thread-id": "approval-2",
          },
        },
      },
      data: {
        kind: "approval-prompt",
        approvalId: "approval-2",
      },
    });
  });

  it("removes invalid FCM registrations", async () => {
    const registrationsPath = tempRegistrationsPath();
    const send = vi.fn(async () => {
      throw { code: "messaging/registration-token-not-registered" };
    });
    const service = createPushService({
      registrationsPath,
      firebaseAdminLoader: async () => ({ send }),
      metrics: createPushMetrics(),
    });

    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "register",
      [{ clientId: "mobile-1", platform: "android", token: "dead-token" }]
    );

    await expect(
      service.internal.send({
        clientId: "mobile-1",
        title: "Approve",
        category: APPROVAL_CATEGORY_DECIDE,
      })
    ).rejects.toMatchObject({ code: "messaging/registration-token-not-registered" });
    expect(service.internal.listRegistrations()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(registrationsPath, "utf-8"))).toEqual([]);
  });

  it("notifies internal listeners when registrations change", async () => {
    const registrationsPath = tempRegistrationsPath();
    const service = createPushService({
      registrationsPath,
      metrics: createPushMetrics(),
    });
    const listener = vi.fn();
    const unsubscribe = service.internal.onRegistrationsChanged(listener);

    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "register",
      [{ clientId: "mobile-1", platform: "android", token: "token-1" }]
    );
    expect(listener).toHaveBeenCalledTimes(1);

    service.internal.unregister("mobile-1");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "register",
      [{ clientId: "mobile-2", platform: "ios", token: "token-2" }]
    );
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("continues batch delivery after removing an invalid registration", async () => {
    const registrationsPath = tempRegistrationsPath();
    const messages: unknown[] = [];
    const send = vi.fn(async (message: { token?: string }) => {
      if (message.token === "dead-token") {
        throw { code: "messaging/registration-token-not-registered" };
      }
      messages.push(message);
      return "message-id";
    });
    const service = createPushService({
      registrationsPath,
      firebaseAdminLoader: async () => ({ send }),
      metrics: createPushMetrics(),
    });

    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "register",
      [{ clientId: "mobile-dead", platform: "android", token: "dead-token" }]
    );
    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "register",
      [{ clientId: "mobile-good", platform: "ios", token: "good-token" }]
    );

    const results = await service.internal.sendBatch({
      title: "Approve",
      category: APPROVAL_CATEGORY_DECIDE,
      data: {
        kind: "approval-prompt",
        approvalId: "approval-1",
        category: APPROVAL_CATEGORY_DECIDE,
      },
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(1);
    expect(results).toMatchObject([
      { clientId: "mobile-dead", sent: false },
      { clientId: "mobile-good", sent: true },
    ]);
    expect(service.internal.listRegistrations()).toEqual([
      expect.objectContaining({ clientId: "mobile-good", token: "good-token" }),
    ]);
    expect(JSON.parse(fs.readFileSync(registrationsPath, "utf-8"))).toEqual([
      ["mobile-good", expect.objectContaining({ token: "good-token" })],
    ]);
  });

  it("degrades to log-only delivery when Firebase is unavailable", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const service = createPushService({
      registrationsPath: tempRegistrationsPath(),
      firebaseAdminLoader: async () => null,
      metrics: createPushMetrics(),
    });

    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "register",
      [{ clientId: "mobile-1", platform: "ios", token: "token-1" }]
    );

    await expect(
      service.internal.send({
        clientId: "mobile-1",
        title: "Approve",
        category: APPROVAL_CATEGORY_DECIDE,
      })
    ).resolves.toMatchObject({ sent: true, logOnly: true, platform: "ios" });
  });

  it("sends approval-cancel data payloads", async () => {
    const messages: unknown[] = [];
    const service = createPushService({
      registrationsPath: tempRegistrationsPath(),
      firebaseAdminLoader: async () => ({
        send: async (message) => {
          messages.push(message);
          return "message-id";
        },
      }),
      metrics: createPushMetrics(),
    });

    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "register",
      [{ clientId: "mobile-1", platform: "android", token: "token-1" }]
    );

    await service.internal.cancel("approval-1");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      data: {
        kind: "approval-cancel",
        approvalId: "approval-1",
        cancelKey: "approval-1",
      },
    });
  });

  it("builds iOS cancel as a silent background push", () => {
    const message = buildFirebaseMessage(
      {
        clientId: "ios-1",
        platform: "ios",
        token: "token-2",
        registeredAt: 1,
      },
      {
        title: "",
        data: {
          kind: "approval-cancel",
          approvalId: "approval-1",
          cancelKey: "approval-1",
        },
      }
    );

    expect(message).toMatchObject({
      token: "token-2",
      data: {
        kind: "approval-cancel",
        approvalId: "approval-1",
        cancelKey: "approval-1",
      },
      apns: {
        headers: {
          "apns-push-type": "background",
          "apns-priority": "5",
        },
        payload: {
          aps: {
            "content-available": 1,
          },
        },
      },
    });
    expect(message).not.toHaveProperty("notification");
  });
});
