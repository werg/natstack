export type BuildProviderTarget = "react-native" | "terminal";
export type BuildProviderArtifactRole = "primary" | "asset" | "html" | "css" | "map";
export type BuildProviderArtifactEncoding = "utf8" | "base64";

export interface BuildProviderArtifact {
  path: string;
  role: BuildProviderArtifactRole;
  contentType: string;
  encoding?: BuildProviderArtifactEncoding;
  platform?: "ios" | "android" | string;
  content?: string;
  stream?: {
    method: string;
    args?: unknown[];
  };
}

export interface BuildProviderInput {
  target: BuildProviderTarget;
  unitName: string;
  sourcePath: string;
  sourceRoot: string;
  workspaceRoot: string;
  effectiveVersion: string;
  manifest: Record<string, unknown>;
}

export interface BuildProviderOutput {
  artifacts: BuildProviderArtifact[];
  metadata?: {
    rnHostAbi?: string | null;
    platform?: "ios" | "android";
  };
}

export interface BuildProvider {
  name: string;
  target: BuildProviderTarget;
  contractVersion: string;
  activeEv: string | null;
  activeBuildKey: string | null;
  build(input: BuildProviderInput): Promise<BuildProviderOutput>;
  streamArtifact?(
    artifact: BuildProviderArtifact,
    input: BuildProviderInput,
  ): Promise<Response>;
}
