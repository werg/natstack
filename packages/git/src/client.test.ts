/**
 * Tests for GitAuthError from client.ts.
 *
 * The full GitClient requires isomorphic-git and a filesystem mock,
 * so we focus on the exported GitAuthError class which is cleanly testable.
 */

import type { HttpClient, StatusRow } from "isomorphic-git";
import git from "isomorphic-git";
import { createRoutingHttpClient, GitAuthError } from "./client.js";
import { GitClient, type FsPromisesLike } from "./client.js";

describe("GitAuthError", () => {
  it("has correct name and message", () => {
    const error = new GitAuthError("Authentication failed");
    expect(error.name).toBe("GitAuthError");
    expect(error.message).toBe("Authentication failed");
  });

  it("is an instance of Error", () => {
    const error = new GitAuthError("auth error");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(GitAuthError);
  });

  it("stores optional statusCode", () => {
    const errorWithCode = new GitAuthError("Forbidden", 403);
    expect(errorWithCode.statusCode).toBe(403);

    const errorWithoutCode = new GitAuthError("No code");
    expect(errorWithoutCode.statusCode).toBeUndefined();
  });
});

describe("createRoutingHttpClient", () => {
  function mockHttpClient(name: string): HttpClient {
    return {
      request: vi.fn(async (request) => ({
        url: request.url,
        method: request.method ?? "GET",
        statusCode: 200,
        statusMessage: name,
        headers: {},
        body: (async function* () {})(),
      })),
    };
  }

  it("routes configured NatStack gateway aliases to the internal client", async () => {
    const internal = mockHttpClient("internal");
    const external = mockHttpClient("external");
    const http = createRoutingHttpClient({
      internalOrigin: "http://127.0.0.1:3030/_git",
      internalOrigins: ["http://100.90.80.70:3030/_git", "https://natstack.example.test/_git"],
      internal,
      external,
    });

    await http.request({
      url: "http://100.90.80.70:3030/_git/projects/natstack/info/refs?service=git-upload-pack",
    });
    await http.request({
      url: "https://natstack.example.test/_git/projects/natstack/git-receive-pack",
      method: "POST",
    });

    expect(internal.request).toHaveBeenCalledTimes(2);
    expect(external.request).not.toHaveBeenCalled();
  });

  it("leaves non-alias remotes on the external client", async () => {
    const internal = mockHttpClient("internal");
    const external = mockHttpClient("external");
    const http = createRoutingHttpClient({
      internalOrigin: "http://127.0.0.1:3030/_git",
      internalOrigins: ["http://100.90.80.70:3030/_git"],
      internal,
      external,
    });

    await http.request({
      url: "https://github.com/example/repo.git/info/refs?service=git-upload-pack",
    });

    expect(internal.request).not.toHaveBeenCalled();
    expect(external.request).toHaveBeenCalledTimes(1);
  });
});

describe("GitClient", () => {
  const fs = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    readdir: vi.fn(),
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    stat: vi.fn(),
  } satisfies FsPromisesLike;

  it("exposes the raw isomorphic-git status matrix", async () => {
    const matrix: StatusRow[] = [["src/app.ts", 1, 2, 1]];
    const statusMatrix = vi.spyOn(git, "statusMatrix").mockResolvedValueOnce(matrix);
    const client = new GitClient(fs, { token: "test-token" });

    await expect(client.statusMatrix("/repo")).resolves.toEqual(matrix);
    expect(statusMatrix).toHaveBeenCalledWith({
      fs: expect.any(Object),
      dir: "/repo",
    });
  });
});
