import { describe, expect, it } from "vitest";
import { autoLaunchRemoteWorkspaceName } from "./remoteWorkspaceAutoSelect.js";

describe("autoLaunchRemoteWorkspaceName", () => {
  it("prefers the ephemeral dev workspace", () => {
    expect(
      autoLaunchRemoteWorkspaceName([{ name: "client" }, { name: "dev", ephemeral: true }])
    ).toBe("dev");
  });

  it("auto-launches a single default workspace", () => {
    expect(autoLaunchRemoteWorkspaceName([{ name: "default" }])).toBe("default");
  });

  it("only auto-launches a single custom workspace when explicitly allowed", () => {
    expect(autoLaunchRemoteWorkspaceName([{ name: "client" }])).toBeNull();
    expect(
      autoLaunchRemoteWorkspaceName([{ name: "client" }], { allowSingleWorkspace: true })
    ).toBe("client");
  });

  it("does not auto-launch one of several saved workspaces", () => {
    expect(
      autoLaunchRemoteWorkspaceName([{ name: "client" }, { name: "default" }], {
        allowSingleWorkspace: true,
      })
    ).toBeNull();
  });
});
