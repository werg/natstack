import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TokenManager } from "@natstack/shared/tokenManager";
import { installPanelTokenPersistence, recoverPersistedPanelTokens } from "./persistedPanelTokens.js";

describe("persisted panel tokens", () => {
  it("recovers panel tokens and handoff metadata after restart", () => {
    const statePath = mkdtempSync(join(tmpdir(), "natstack-panel-tokens-"));
    const original = new TokenManager();
    installPanelTokenPersistence(original, statePath);

    const token = original.createToken("panel-1", "panel");
    original.setPanelParent("panel-1", "root");
    original.setPanelOwner("panel-1", "shell:owner", "conn-1");

    const recovered = new TokenManager();
    const result = recoverPersistedPanelTokens(recovered, statePath);

    expect(result).toMatchObject({ recovered: 1, errors: 0 });
    expect(recovered.validateToken(token)).toEqual({ callerId: "panel-1", callerKind: "panel" });
    expect(recovered.getPanelParent("panel-1")).toBe("root");
    expect(recovered.getPanelOwner("panel-1")).toBe("shell:owner");
    expect(recovered.getPanelOwnerConnection("panel-1")).toBeUndefined();
  });
});
