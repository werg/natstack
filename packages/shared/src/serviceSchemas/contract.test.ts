import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTypedServiceClient } from "../typedServiceClient.js";
import type { ServiceMethodSchemas } from "../typedServiceClient.js";
import { appMethods } from "./app.js";
import { authMethods } from "./auth.js";
import { autofillMethods } from "./autofill.js";
import { blobstoreMethods } from "./blobstore.js";
import { buildMethods } from "./build.js";
import { corsApprovalMethods } from "./corsApproval.js";
import { credentialsMethods } from "./credentials.js";
import { eventsMethods } from "./events.js";
import { extensionsMethods } from "./extensions.js";
import { externalOpenMethods } from "./externalOpen.js";
import { fsMethods } from "./fs.js";
import { gitInteropMethods } from "./gitInterop.js";
import { menuMethods } from "./menu.js";
import { metaMethods } from "./meta.js";
import { notificationMethods } from "./notification.js";
import { panelMethods } from "./panel.js";
import { panelLogMethods } from "./panelLog.js";
import { panelRuntimeMethods } from "./panelRuntime.js";
import { panelTreeMethods } from "./panelTree.js";
import { pushMethods } from "./push.js";
import { remoteCredMethods } from "./remoteCred.js";
import { runtimeMethods } from "./runtime.js";
import { evalMethods } from "./eval.js";
import { settingsMethods } from "./settings.js";
import { shellApprovalMethods } from "./shellApproval.js";
import { tokensMethods } from "./tokens.js";
import { vcsMethods } from "./vcs.js";
import { viewMethods } from "./view.js";
import { workerLogMethods } from "./workerLog.js";
import { workspaceMethods } from "./workspace.js";
import { workspaceStateMethods } from "./workspaceState.js";

type ServiceTable = {
  service: string;
  file: string;
  methods: ServiceMethodSchemas;
};

const serviceTables: ServiceTable[] = [
  { service: "app", file: "app.ts", methods: appMethods },
  { service: "auth", file: "auth.ts", methods: authMethods },
  { service: "autofill", file: "autofill.ts", methods: autofillMethods },
  { service: "blobstore", file: "blobstore.ts", methods: blobstoreMethods },
  { service: "build", file: "build.ts", methods: buildMethods },
  { service: "corsApproval", file: "corsApproval.ts", methods: corsApprovalMethods },
  { service: "credentials", file: "credentials.ts", methods: credentialsMethods },
  { service: "events", file: "events.ts", methods: eventsMethods },
  { service: "extensions", file: "extensions.ts", methods: extensionsMethods },
  { service: "externalOpen", file: "externalOpen.ts", methods: externalOpenMethods },
  { service: "fs", file: "fs.ts", methods: fsMethods },
  { service: "gitInterop", file: "gitInterop.ts", methods: gitInteropMethods },
  { service: "menu", file: "menu.ts", methods: menuMethods },
  { service: "meta", file: "meta.ts", methods: metaMethods },
  { service: "notification", file: "notification.ts", methods: notificationMethods },
  { service: "panel", file: "panel.ts", methods: panelMethods },
  { service: "panelLog", file: "panelLog.ts", methods: panelLogMethods },
  { service: "panelRuntime", file: "panelRuntime.ts", methods: panelRuntimeMethods },
  { service: "panelTree", file: "panelTree.ts", methods: panelTreeMethods },
  { service: "push", file: "push.ts", methods: pushMethods },
  { service: "remoteCred", file: "remoteCred.ts", methods: remoteCredMethods },
  { service: "runtime", file: "runtime.ts", methods: runtimeMethods },
  { service: "eval", file: "eval.ts", methods: evalMethods },
  { service: "settings", file: "settings.ts", methods: settingsMethods },
  { service: "shellApproval", file: "shellApproval.ts", methods: shellApprovalMethods },
  { service: "tokens", file: "tokens.ts", methods: tokensMethods },
  { service: "vcs", file: "vcs.ts", methods: vcsMethods },
  { service: "view", file: "view.ts", methods: viewMethods },
  { service: "workerLog", file: "workerLog.ts", methods: workerLogMethods },
  { service: "workspace", file: "workspace.ts", methods: workspaceMethods },
  { service: "workspace-state", file: "workspaceState.ts", methods: workspaceStateMethods },
];

const approvedReturnlessMethods = new Set([
  // `invokeStream` returns a live Response object from the extension streaming
  // bridge. That transport is validated by stream-level tests rather than a
  // JSON-compatible Zod return schema.
  "extensions.invokeStream",
]);

describe("service schema contracts", () => {
  it("covers every service schema file in this directory", () => {
    const schemaDir = dirname(fileURLToPath(import.meta.url));
    const schemaFiles = readdirSync(schemaDir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .sort();

    expect(serviceTables.map((table) => table.file).sort()).toEqual(schemaFiles);
  });

  it("declares args and approved return schemas for every method", () => {
    for (const { service, methods } of serviceTables) {
      expect(Object.keys(methods).length, `${service} should declare at least one method`).toBeGreaterThan(0);
      for (const [method, schema] of Object.entries(methods)) {
        expect(
          typeof schema.args.safeParse,
          `${service}.${method} should have a Zod args schema`
        ).toBe("function");

        const key = `${service}.${method}`;
        if (!approvedReturnlessMethods.has(key)) {
          expect(schema.returns, `${key} should declare a return schema`).toBeDefined();
        }
      }
    }
  });

  it("builds typed clients without dotted-method collisions", () => {
    for (const { service, methods } of serviceTables) {
      expect(() =>
        createTypedServiceClient(service, methods, async () => undefined)
      ).not.toThrow();
    }
  });
});
