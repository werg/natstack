import { describe, it, expect } from "vitest";
import { parseActionData } from "./ActionMessage.js";

describe("parseActionData", () => {
  it("parses valid RichActionData JSON with args, result, isError", () => {
    const content = JSON.stringify({
      type: "Read",
      description: "Reading src/index.ts",
      status: "complete",
      args: { file_path: "src/index.ts", offset: 0 },
      result: "file contents here",
      isError: false,
      resultTruncated: false,
    });
    const data = parseActionData(content);
    expect(data.type).toBe("Read");
    expect(data.description).toBe("Reading src/index.ts");
    expect(data.status).toBe("complete");
    expect(data.args).toEqual({ file_path: "src/index.ts", offset: 0 });
    expect(data.result).toBe("file contents here");
    expect(data.isError).toBe(false);
    expect(data.resultTruncated).toBe(false);
  });

  it("parses legacy ActionData JSON (no rich fields)", () => {
    const content = JSON.stringify({
      type: "Bash",
      description: "Running command",
      status: "pending",
    });
    const data = parseActionData(content);
    expect(data.type).toBe("Bash");
    expect(data.status).toBe("pending");
    expect(data.args).toBeUndefined();
    expect(data.result).toBeUndefined();
    expect(data.isError).toBeUndefined();
  });

  it('normalizes legacy status: "error" to status: "complete" + isError: true', () => {
    const content = JSON.stringify({
      type: "Edit",
      description: "Error: file not found",
      status: "error",
    });
    const data = parseActionData(content);
    expect(data.status).toBe("complete");
    expect(data.isError).toBe(true);
  });

  it("falls back for malformed JSON", () => {
    const data = parseActionData("this is not json at all");
    expect(data.type).toBe("Unknown");
    expect(data.status).toBe("pending");
    expect(data.description).toBe("this is not json at all");
  });

  it("handles empty string input", () => {
    const data = parseActionData("");
    expect(data.type).toBe("Unknown");
    expect(data.status).toBe("pending");
  });

  it("extracts first JSON object from duplicated content", () => {
    const obj = { type: "Read", description: "test", status: "pending" };
    const content = JSON.stringify(obj) + JSON.stringify({ type: "Other", description: "other", status: "complete" });
    const data = parseActionData(content);
    expect(data.type).toBe("Read");
    expect(data.description).toBe("test");
  });

  it("overrides status to complete when complete flag is true", () => {
    const content = JSON.stringify({
      type: "Read",
      description: "Reading file",
      status: "pending",
    });
    const data = parseActionData(content, true);
    expect(data.status).toBe("complete");
  });

  it("keeps complete status even when complete flag is true for error normalization", () => {
    const content = JSON.stringify({
      type: "Edit",
      description: "Error: fail",
      status: "error",
    });
    const data = parseActionData(content, true);
    expect(data.status).toBe("complete");
    expect(data.isError).toBe(true);
  });
});
