import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RPC_METHODS } from "@natstack/shared/approvalContract";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { createApprovalPushBridge, type ApprovalPushBridge } from "../../src/server/services/approvalPushBridge.js";
import { createApprovalQueue, type ApprovalQueueWithListeners } from "../../src/server/services/approvalQueue.js";
import { createPushMetrics, type PushMetrics } from "../../src/server/services/pushMetrics.js";
import { createPushService, type PushServiceResult } from "../../src/server/services/pushService.js";
import { createShellApprovalService } from "../../src/server/services/shellApprovalService.js";
import { createShellPresenceService } from "../../src/server/services/shellPresenceService.js";
interface SentMessage {
    data?: Record<string, string>;
}
interface Harness {
    approvalQueue: ApprovalQueueWithListeners;
    bridge: ApprovalPushBridge;
    metrics: PushMetrics;
    mobileTransport: FakeTransport;
    desktopTransport: FakeTransport;
    pushService: PushServiceResult;
    sentMessages: SentMessage[];
}
class FakeTransport {
    constructor(private readonly services: Record<string, ServiceDefinition>, private readonly callerId: string) { }
    async call(_target: "main", rpcMethod: string, args: unknown[]): Promise<unknown> {
        const [serviceName, method] = rpcMethod.split(".");
        const service = serviceName ? this.services[serviceName] : undefined;
        if (!service || !method) {
            throw new Error(`No fake service registered for ${rpcMethod}`);
        }
    return service.handler(
      { caller: createVerifiedCaller(this.callerId, "shell") },
      method,
      args
    );
  }
}
function tempRegistrationsPath(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "natstack-approval-flow-")), "registrations.json");
}
async function flushAsyncWork(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
    }
}
async function createHarness(): Promise<Harness> {
    const sentMessages: SentMessage[] = [];
    const approvalQueue = createApprovalQueue({ eventService: { emit: vi.fn() } as never });
    const metrics = createPushMetrics();
    const pushService = createPushService({
        registrationsPath: tempRegistrationsPath(),
        firebaseAdminLoader: async () => ({
            send: async (message) => {
                sentMessages.push(message as SentMessage);
                return `fake-message-${sentMessages.length}`;
            },
        }),
        metrics,
    });
    const shellApprovalService = createShellApprovalService({ approvalQueue, metrics });
    const services = {
        push: pushService.definition,
        shellApproval: shellApprovalService,
    };
    const mobileTransport = new FakeTransport(services, "mobile-shell");
    const desktopTransport = new FakeTransport(services, "desktop-shell");
    await mobileTransport.call("main", RPC_METHODS.push.register, [{
            clientId: "mobile-shell",
            platform: "android",
            token: "fake-fcm-token",
        }]);
    const bridge = createApprovalPushBridge({
        approvalQueue,
        push: pushService.internal,
        shellPresence: createShellPresenceService().internal,
    });
    return {
        approvalQueue,
        bridge,
        metrics,
        mobileTransport,
        desktopTransport,
        pushService,
        sentMessages,
    };
}
function requestCredentialApproval(queue: ApprovalQueueWithListeners) {
    return queue.request({
        callerId: "worker:approval-e2e",
        callerKind: "worker",
        repoPath: "/repo",
        effectiveVersion: "hash-approval-e2e",
        credentialId: "github-token",
        credentialLabel: "GitHub",
        audience: [{ url: "https://api.github.com/", match: "origin" }],
        injection: {
            type: "header",
            name: "authorization",
            valueTemplate: "Bearer {token}",
        },
        accountIdentity: { providerUserId: "octocat", username: "octocat" },
        scopes: ["repo"],
    });
}
afterEach(() => {
    vi.restoreAllMocks();
});
describe("approval flow e2e", () => {
    it("pushes a credential approval to mobile and resolves it through shellApproval", async () => {
        const harness = await createHarness();
        const approvalPromise = requestCredentialApproval(harness.approvalQueue);
        await flushAsyncWork();
        const approval = harness.approvalQueue.listPending()[0];
        expect(approval).toMatchObject({ kind: "credential", credentialLabel: "GitHub" });
        expect(harness.sentMessages).toHaveLength(1);
        expect(harness.sentMessages[0]?.data).toMatchObject({
            kind: "approval-prompt",
            approvalId: approval!.approvalId,
            approvalKind: "credential",
            actionsJson: JSON.stringify([
                { id: "once", title: "Once" },
                { id: "version", title: "Trust Version" },
                { id: "deny", title: "Deny" },
                { id: "open", title: "Open" },
                { id: "session", title: "Session" },
            ]),
        });
        await harness.mobileTransport.call("main", RPC_METHODS.shellApproval.resolve, [approval!.approvalId, "once"]);
        await expect(approvalPromise).resolves.toBe("once");
        expect(harness.approvalQueue.listPending()).toEqual([]);
        harness.bridge.stop();
    });
    it("settles only the first decision when mobile and desktop resolve at the same time", async () => {
        const harness = await createHarness();
        const approvalPromise = requestCredentialApproval(harness.approvalQueue);
        await flushAsyncWork();
        const approvalId = harness.approvalQueue.listPending()[0]!.approvalId;
        await Promise.all([
            harness.mobileTransport.call("main", RPC_METHODS.shellApproval.resolve, [approvalId, "once"]),
            harness.desktopTransport.call("main", RPC_METHODS.shellApproval.resolve, [approvalId, "deny"]),
        ]);
        await expect(approvalPromise).resolves.toBe("once");
        expect(harness.approvalQueue.listPending()).toEqual([]);
        expect(harness.metrics.snapshot().approval_resolved_total).toEqual({
            "decision=once,source=shell": 1,
        });
        harness.bridge.stop();
    });
    it("fans out a cancel push when another shell resolves a sent mobile approval", async () => {
        const harness = await createHarness();
        const approvalPromise = requestCredentialApproval(harness.approvalQueue);
        await flushAsyncWork();
        const approvalId = harness.approvalQueue.listPending()[0]!.approvalId;
        await harness.desktopTransport.call("main", RPC_METHODS.shellApproval.resolve, [approvalId, "session"]);
        await expect(approvalPromise).resolves.toBe("session");
        await flushAsyncWork();
        expect(harness.sentMessages).toHaveLength(2);
        expect(harness.sentMessages[0]?.data).toMatchObject({
            kind: "approval-prompt",
            approvalId,
        });
        expect(harness.sentMessages[1]?.data).toMatchObject({
            kind: "approval-cancel",
            approvalId,
            cancelKey: approvalId,
        });
        expect(harness.pushService.internal.listRegistrations()).toHaveLength(1);
        harness.bridge.stop();
    });
});
