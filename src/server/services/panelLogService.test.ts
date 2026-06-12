import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { createPanelLogService, type PanelLogRecord } from "./panelLogService.js";

describe("panelLogService", () => {
  const ctx = { caller: createVerifiedCaller("shell", "shell") };

  it("forwards a valid append batch to deps.onRecords", async () => {
    const onRecords = vi.fn();
    const service = createPanelLogService({ onRecords });

    const records: PanelLogRecord[] = [
      {
        unitSource: "panels/chat",
        panelId: "panel-1",
        timestamp: 1234,
        level: "error",
        message: "boom",
        source: "console",
      },
      {
        unitSource: "panels/chat",
        panelId: "panel-1",
        timestamp: 1235,
        level: "warn",
        message: "renderer gone",
        source: "lifecycle",
        fields: { reason: "crashed" },
      },
    ];

    await service.handler(ctx, "append", [records]);

    expect(onRecords).toHaveBeenCalledTimes(1);
    expect(onRecords).toHaveBeenCalledWith(records);
  });

  it("does not invoke deps.onRecords for an empty batch", async () => {
    const onRecords = vi.fn();
    const service = createPanelLogService({ onRecords });

    await service.handler(ctx, "append", [[]]);

    expect(onRecords).not.toHaveBeenCalled();
  });

  it("rejects unknown methods", async () => {
    const onRecords = vi.fn();
    const service = createPanelLogService({ onRecords });

    await expect(service.handler(ctx, "nope", [])).rejects.toThrow("Unknown method: nope");
    expect(onRecords).not.toHaveBeenCalled();
  });
});
