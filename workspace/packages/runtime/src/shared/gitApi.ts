/**
 * Git interop client — the portable `git` namespace derived once in
 * `createHostedRuntime`. Previously this object literal was duplicated verbatim
 * in the panel and worker barrels; it now lives here so all targets share it.
 * `http` is the credential client's `gitHttp` (credentialed git-over-HTTP).
 */

import type { RpcCaller } from "@natstack/rpc";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { gitInteropMethods } from "@natstack/shared/serviceSchemas/gitInterop";
import type { CredentialClient } from "./credentials.js";

export interface GitRemoteSpec {
  name: string;
  url: string;
  branch?: string;
}

export interface ImportProjectRequest {
  path: string;
  remote: GitRemoteSpec;
  branch?: string;
  credentialId?: string;
}

export interface ImportedWorkspaceRepo {
  path: string;
  remote: GitRemoteSpec;
}

export interface CompleteWorkspaceDependenciesResult {
  imported: ImportedWorkspaceRepo[];
  skipped: Array<{ path: string; reason: "already-present" | "unsupported-path" }>;
  failed: Array<{ path: string; error: string }>;
}

export interface RuntimeGitApi {
  http: CredentialClient["gitHttp"];
  importProject(request: ImportProjectRequest): Promise<ImportedWorkspaceRepo>;
  completeWorkspaceDependencies(options?: {
    credentialId?: string;
  }): Promise<CompleteWorkspaceDependenciesResult>;
  setSharedRemote(
    repoPath: string,
    remote: GitRemoteSpec
  ): Promise<Record<string, unknown> | undefined>;
  removeSharedRemote(
    repoPath: string,
    remoteName: string
  ): Promise<Record<string, unknown> | undefined>;
}

export function createGitApi(rpc: RpcCaller, gitHttp: CredentialClient["gitHttp"]): RuntimeGitApi {
  const gitInterop = createTypedServiceClient("gitInterop", gitInteropMethods, (svc, method, args) =>
    rpc.call("main", `${svc}.${method}`, args)
  );
  return {
    http: gitHttp,
    importProject: (request) => gitInterop.importProject(request),
    completeWorkspaceDependencies: (options = {}) =>
      gitInterop.completeWorkspaceDependencies(options),
    setSharedRemote: (repoPath, remote) => gitInterop.setSharedRemote(repoPath, remote),
    removeSharedRemote: (repoPath, remoteName) =>
      gitInterop.removeSharedRemote(repoPath, remoteName),
  };
}
