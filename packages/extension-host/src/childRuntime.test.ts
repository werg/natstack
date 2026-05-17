import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("extension child runtime", () => {
  it("routes ctx.workers.callDO through the registered workers service", () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "childRuntime.ts"),
      "utf8",
    );

    expect(source).toContain('"workers.callDO"');
    expect(source).not.toContain('"worker.callDO"');
  });

  it("supports chunked streaming extension fetch bodies", () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "childRuntime.ts"),
      "utf8",
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
      "utf8",
    );

    expect(source).toContain("settleWaitUntil(waitUntil)");
    expect(source).not.toContain("await Promise.allSettled(waitUntil)");
  });

  it("installs CommonJS globals before importing the extension bundle", () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "childRuntime.ts"),
      "utf8",
    );

    expect(source).toContain("installCommonJsGlobals(bundlePath)");
    expect(source.indexOf("installCommonJsGlobals(bundlePath)")).toBeLessThan(
      source.indexOf("await importExtensionModule(bundlePath)"),
    );
    expect(source).toContain("return import(pathToFileURL(bundlePath).href)");
    expect(source).toContain("createRequire(pathToFileURL(bundlePath).href)");
    expect(source).toContain("globals.__dirname = path.dirname(bundlePath)");
  });
});
