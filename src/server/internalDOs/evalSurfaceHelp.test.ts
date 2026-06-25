import { describe, expect, it } from "vitest";
import {
  describeEvalBindingSurface,
  EVAL_RUNTIME_METHOD_NOTES,
  invalidHelpArgumentResponse,
} from "./evalSurfaceHelp.js";

describe("describeEvalBindingSurface (help('<binding>') reflects the injected surface)", () => {
  // The fs case: the injected client exposes open()/readFile()/mktemp() but NOT the low-level
  // handle* wire methods, which the raw service schema DOES advertise.
  const fsService = {
    open: { description: "wire open → { handleId }", argsSchema: {} },
    readFile: { description: "read a file", argsSchema: {} },
    handleClose: { description: "low-level handle close", argsSchema: {} },
    handleStat: { description: "low-level handle stat", argsSchema: {} },
  };

  it("drops wire methods the injected object doesn't expose (no fs.handleClose leak)", () => {
    const out = describeEvalBindingSurface("fs", ["open", "readFile", "mktemp"], fsService);
    expect(out).not.toBeNull();
    expect(Object.keys(out!.methods).sort()).toEqual(["mktemp", "open", "readFile"]);
    expect(out!.methods).not.toHaveProperty("handleClose");
    expect(out!.methods).not.toHaveProperty("handleStat");
  });

  it("a known ergonomic note WINS over the raw wire schema (fs.open → FileHandle, not {handleId})", () => {
    const out = describeEvalBindingSurface("fs", ["open"], fsService);
    expect(out!.methods["open"]).toBe(EVAL_RUNTIME_METHOD_NOTES["fs.open"]);
    expect((out!.methods["open"] as { description: string }).description).toContain("FileHandle");
    expect((out!.methods["open"] as { description: string }).description).not.toContain("handleId");
  });

  it("reuses the RPC-service schema for methods with no override (rich arg info preserved)", () => {
    const out = describeEvalBindingSurface("fs", ["readFile"], fsService);
    expect(out!.methods["readFile"]).toBe(fsService.readFile);
  });

  it("describes mktemp as a temp FILE path (not a directory) so it isn't misused", () => {
    const out = describeEvalBindingSurface("fs", ["mktemp"], fsService);
    const desc = (out!.methods["mktemp"] as { description: string }).description;
    expect(desc).toContain("NOT created");
    expect(desc).toMatch(/mkdir|NOT Node's mkdtemp/);
  });

  it("documents worker runtime methods with the ergonomic eval signatures", () => {
    const out = describeEvalBindingSurface(
      "workers",
      ["create", "destroy", "listInstanceSources"],
      {}
    );

    expect((out!.methods["create"] as { description: string }).description).toContain(
      "ctx:${ctx.contextId}"
    );
    expect((out!.methods["destroy"] as { description: string }).description).toContain(
      "not the full object"
    );
    expect((out!.methods["listInstanceSources"] as { description: string }).description).toContain(
      'rpc.call("main", "workers.listSources", [])'
    );
  });

  it("falls back to a generic introspect note for a live method with no schema or override", () => {
    const out = describeEvalBindingSurface("widget", ["frobnicate"], {});
    expect((out!.methods["frobnicate"] as { description: string }).description).toContain(
      "introspect the return value"
    );
  });

  it("sorts methods and tags the surface as injected-runtime", () => {
    const out = describeEvalBindingSurface("fs", ["readFile", "open", "mktemp"], fsService);
    expect(Object.keys(out!.methods)).toEqual(["mktemp", "open", "readFile"]);
    expect(out!.surface).toBe("injected-runtime");
    expect(out!.note).toContain('rpc.call("main", "fs.…"');
    expect(out!.note).toContain("services.fs");
  });

  it("returns null when there are no live methods (caller falls back to the service schema)", () => {
    expect(describeEvalBindingSurface("vcs", [], { applyEdits: {} })).toBeNull();
  });
});

describe("invalidHelpArgumentResponse", () => {
  it("turns help(workers) into a useful non-throwing diagnostic", () => {
    expect(
      invalidHelpArgumentResponse({ create: () => undefined, destroy: () => undefined })
    ).toEqual({
      error: "help() expects a string service or runtime binding name.",
      received: "create, destroy",
      example: 'await help("workers")',
      note:
        "Pass the binding name as a string. For a live object's enumerable methods, " +
        "Object.keys(workers) also works.",
    });
  });
});
