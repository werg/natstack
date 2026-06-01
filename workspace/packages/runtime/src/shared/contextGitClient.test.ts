import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@natstack/rpc";
import type { GitClient, RepoStatus } from "@natstack/git";
import { createContextAwareGitClient } from "./contextGitClient.js";

function makeStatus(files: RepoStatus["files"] = []): RepoStatus {
  return {
    branch: "main",
    commit: "abc123",
    dirty: files.length > 0,
    files,
  };
}

describe("createContextAwareGitClient", () => {
  it("routes workspace repo status and addAll through context-aware git service", async () => {
    const serviceStatus = makeStatus([
      { path: "index.ts", status: "modified", staged: false, unstaged: true },
    ]);
    const rpc = {
      call: vi.fn(async (_target: string, method: string) => {
        if (method === "git.contextStatus") return serviceStatus;
        return undefined;
      }),
    } as unknown as Pick<RpcClient, "call"> & { call: ReturnType<typeof vi.fn> };
    const client = {
      status: vi.fn(async () => makeStatus()),
      addAll: vi.fn(async () => undefined),
    } as unknown as GitClient;
    const originalStatus = client.status as unknown as ReturnType<typeof vi.fn>;
    const originalAddAll = client.addAll as unknown as ReturnType<typeof vi.fn>;

    const wrapped = createContextAwareGitClient(client, rpc);

    await expect(wrapped.status("panels/spectrolite")).resolves.toBe(serviceStatus);
    await wrapped.addAll("panels/spectrolite");

    expect(rpc.call).toHaveBeenCalledWith("main", "git.contextStatus", ["panels/spectrolite"]);
    expect(rpc.call).toHaveBeenCalledWith("main", "git.contextAddAll", ["panels/spectrolite"]);
    expect(originalStatus).not.toHaveBeenCalled();
    expect(originalAddAll).not.toHaveBeenCalled();
  });

  it("leaves non-workspace paths on the original git client", async () => {
    const originalStatus = makeStatus();
    const rpc = { call: vi.fn() } as unknown as Pick<RpcClient, "call"> & {
      call: ReturnType<typeof vi.fn>;
    };
    const client = {
      status: vi.fn(async () => originalStatus),
      addAll: vi.fn(async () => undefined),
    } as unknown as GitClient;
    const originalStatusFn = client.status as unknown as ReturnType<typeof vi.fn>;
    const originalAddAllFn = client.addAll as unknown as ReturnType<typeof vi.fn>;

    const wrapped = createContextAwareGitClient(client, rpc);

    await expect(wrapped.status("/tmp/repo")).resolves.toBe(originalStatus);
    await wrapped.addAll("/tmp/repo");

    expect(rpc.call).not.toHaveBeenCalled();
    expect(originalStatusFn).toHaveBeenCalledWith("/tmp/repo");
    expect(originalAddAllFn).toHaveBeenCalledWith("/tmp/repo");
  });

  it("leaves malformed status arguments on the original git client for validation", async () => {
    const rpc = { call: vi.fn() } as unknown as Pick<RpcClient, "call"> & {
      call: ReturnType<typeof vi.fn>;
    };
    const client = {
      status: vi.fn(async () => makeStatus()),
      addAll: vi.fn(async () => undefined),
    } as unknown as GitClient;
    const originalStatusFn = client.status as unknown as ReturnType<typeof vi.fn>;

    const wrapped = createContextAwareGitClient(client, rpc);
    const badArg = { dir: "panels/spectrolite" };

    await wrapped.status(badArg as never);

    expect(rpc.call).not.toHaveBeenCalled();
    expect(originalStatusFn).toHaveBeenCalledWith(badArg);
  });
});
