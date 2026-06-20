import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("extension child runtime", () => {
  it("exposes unified RPC for extension userland targets", () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "childRuntime.ts"),
      "utf8"
    );

    expect(source).toContain("rpc: {");
    expect(source).toContain("rpcCall<T>(method, args, targetId)");
    expect(source).toContain('type: "ws:route"');
    expect(source.includes("call" + "DO")).toBe(false);
  });

  it("synthesizes a rejecting response from ws:routed-response-error and logs ws:routed-event-error", () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "childRuntime.ts"),
      "utf8"
    );

    // A2 (silent-drop): the server's routed-error frames must not be dropped.
    expect(source).toContain('message.type === "ws:routed-response-error"');
    expect(source).toContain('message.type === "ws:routed-event-error"');
    // The response-error path synthesizes a rejecting `response` envelope fed to
    // the message listeners so the pending call settles instead of hanging.
    const responseErrorIdx = source.indexOf('message.type === "ws:routed-response-error"');
    const eventErrorIdx = source.indexOf('message.type === "ws:routed-event-error"');
    expect(responseErrorIdx).toBeGreaterThan(-1);
    expect(eventErrorIdx).toBeGreaterThan(-1);
    expect(source.slice(responseErrorIdx, eventErrorIdx)).toContain('type: "response"');
    expect(source.slice(responseErrorIdx, eventErrorIdx)).toContain("for (const listener of listeners) listener(envelope)");
  });

  it("supports chunked streaming extension fetch bodies", () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "childRuntime.ts"),
      "utf8"
    );

    expect(source).toContain("__stream");
    expect(source).toContain("responseBodyToEnvelope");
    expect(source).toContain("requestBodyFromEnvelope");
    expect(source).toContain("extension.fetchResponseBodyChunk");
    expect(source).toContain("extensions.fetchRequestBodyChunk");
  });

  it("does not block fetch responses on waitUntil work", () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "childRuntime.ts"),
      "utf8"
    );

    expect(source).toContain("settleWaitUntil(waitUntil)");
    expect(source).not.toContain("await Promise.allSettled(waitUntil)");
  });

  it("installs CommonJS globals before importing the extension bundle", () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "childRuntime.ts"),
      "utf8"
    );

    expect(source).toContain("installCommonJsGlobals(bundlePath)");
    expect(source.indexOf("installCommonJsGlobals(bundlePath)")).toBeLessThan(
      source.indexOf("await importExtensionModule(bundlePath)")
    );
    expect(source).toContain("return import(pathToFileURL(bundlePath).href)");
    expect(source).toContain("createRequire(pathToFileURL(bundlePath).href)");
    expect(source).toContain("globals.__dirname = path.dirname(bundlePath)");
  });
});
