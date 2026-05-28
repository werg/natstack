import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { createWorkerLogService } from "./workerLogService.js";

describe("workerLogService", () => {
  it("uses explicit worker source fields when regular workers forward console output", async () => {
    const onLog = vi.fn();
    const service = createWorkerLogService({ onLog });

    await service.handler({ caller: createVerifiedCaller("worker:my_worker", "worker") }, "write", [
      "error",
      "boom",
      { source: "workers/my-worker" },
    ]);

    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "workers/my-worker",
        callerId: "worker:my_worker",
        level: "error",
        message: "boom",
      })
    );
  });
});
