import type {
  ApprovalOperationDescriptor,
  ApprovalRequesterCategory,
  PendingApproval,
  PendingCapabilityApproval,
  PendingCredentialApproval,
  PendingCredentialInputApproval,
  PendingDeviceCodeApproval,
  PendingUnitBatchApproval,
} from "./approvals.js";

function truncateId(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/** Drop common id prefixes for a friendlier fallback label when no title exists. */
function prettifyApprovalId(id: string): string {
  const stripped = id.replace(/^(do-service:|do:|worker:|panel:|app:|extension:)/, "");
  const segments = stripped.split(":");
  const last = segments[segments.length - 1] ?? stripped;
  return truncateId(last);
}

function isIdentityScopedVersionApproval(approval: PendingApproval): boolean {
  if (
    approval.requester?.category === "eval" ||
    approval.requester?.category === "internal-service"
  ) {
    return true;
  }
  return approval.effectiveVersion === "internal" || approval.repoPath === "natstack/internal";
}

function trustVersionLabel(approval: PendingApproval, fallback = "Trust version"): string {
  return isIdentityScopedVersionApproval(approval) ? "Trust identity" : fallback;
}

function trustSubject(approval: PendingApproval): string {
  return isIdentityScopedVersionApproval(approval)
    ? "this requester identity"
    : "this code version";
}

function exactTrustSubject(approval: PendingApproval): string {
  return isIdentityScopedVersionApproval(approval)
    ? "this exact runtime identity"
    : "this exact code version";
}

function networkTrustLabel(approval: PendingApproval): string {
  return isIdentityScopedVersionApproval(approval)
    ? "Trust identity with network"
    : "Trust version with network";
}

function corsTrustLabel(approval: PendingApproval): string {
  return isIdentityScopedVersionApproval(approval)
    ? "Trust identity with CORS"
    : "Trust version with CORS";
}

export type ApprovalRiskTone = "standard" | "caution" | "danger";

export function getRequesterCategoryLabel(category: ApprovalRequesterCategory): string {
  switch (category) {
    case "panel":
      return "Panel";
    case "workspace-app":
      return "App";
    case "agent":
      return "Agent";
    case "eval":
      return "Eval";
    case "worker":
      return "Worker";
    case "durable-object":
      return "DO";
    case "extension":
      return "Extension";
    case "system":
      return "Workspace";
    case "internal-service":
      return "Internal service";
    case "unknown":
      return "Requester";
  }
}

export function getApprovalOperationKindLabel(kind: ApprovalOperationDescriptor["kind"]): string {
  switch (kind) {
    case "browser":
      return "Browser";
    case "credential":
      return "Credential";
    case "filesystem":
      return "Filesystem";
    case "git":
      return "Git";
    case "inspection":
      return "Inspection";
    case "network":
      return "Network access";
    case "panel":
      return "Panel";
    case "runtime":
      return "Runtime";
    case "worker-lifecycle":
      return "Worker lifecycle";
    case "workspace":
      return "Workspace";
    case "service-setup":
      return "Service setup";
    case "userland":
      return "User request";
    case "device-code":
      return "Device sign-in";
    case "unknown":
      return "Operation";
  }
}

export function getApprovalRiskTone(approval: PendingApproval): ApprovalRiskTone {
  if (approval.kind === "unit-batch") {
    return approval.units.some((unit) => unit.unitKind === "extension") ? "danger" : "caution";
  }
  if (approval.kind === "credential" && approval.oauthAudienceDomainMismatch) {
    return "caution";
  }
  if (approval.kind === "capability") {
    if (approval.severity === "severe") return "danger";
  }
  return "standard";
}

export function getApprovalCategoryLabel(approval: PendingApproval): string {
  if (approval.kind === "credential") {
    if (isOAuthCredentialConnectionApproval(approval)) {
      return "Connection request";
    }
    if (approval.credentialUse === "git-http") {
      return approval.gitOperation?.action === "write" ? "Git write" : "Git read";
    }
    return "Access request";
  }
  if (approval.kind === "client-config") {
    return "Service setup";
  }
  if (approval.kind === "credential-input") {
    return "Service setup";
  }
  if (approval.kind === "userland") {
    return `${userlandCallerKindLabel(approval.callerKind)} request`;
  }
  if (approval.kind === "device-code") {
    return "Device sign-in";
  }
  if (approval.kind === "unit-batch") {
    if (approval.trigger === "management") {
      if (approval.units.every((unit) => unit.unitKind === "app")) return "App management";
      if (approval.units.every((unit) => unit.unitKind === "extension"))
        return "Extension management";
      return "Unit management";
    }
    if (approval.trigger === "source-change") {
      if (approval.units.every((unit) => unit.unitKind === "app")) return "App source";
      if (approval.units.every((unit) => unit.unitKind === "extension")) return "Extension source";
      return "Unit source";
    }
    if (approval.units.every((unit) => unit.unitKind === "app")) return "App setup";
    if (approval.units.every((unit) => unit.unitKind === "extension")) return "Extension setup";
    return "Workspace setup";
  }
  if (approval.capability === "workspace-repo-write") {
    const isWorkspaceSourceChange = approval.grantResourceKey?.startsWith(
      "workspace-source-change:"
    );
    if (isWorkspaceSourceChange) {
      return "Workspace source";
    }
    return approval.resource?.value === "meta" ? "Config edit" : "Write request";
  }
  if (approval.capability === "workspace-shared-git-remote") {
    return "Remote config";
  }
  if (approval.capability === "workspace-project-import") {
    return "Project import";
  }
  if (approval.capability === "external-network-fetch") {
    return "Network access";
  }
  if (approval.capability === "cors-response-read") {
    return "Network access";
  }
  if (approval.capability === "workerd.inspector") {
    return "Inspection";
  }
  if (approval.capability === "client-config-delete") {
    return "Service setup";
  }
  if (isBrowserOpenApproval(approval)) {
    return isOAuthExternalApproval(approval) ? "Sign-in action" : "Browser action";
  }
  return "Capability request";
}

export function getStandardActionCopy(
  approval: PendingCredentialApproval | PendingCapabilityApproval
): {
  once: { label: string; description: string };
  session: { label: string; description: string };
  version: { label: string; description: string };
  repo: { label: string; description: string };
  denyDescription: string;
} {
  if (approval.kind === "credential") {
    if (isOAuthCredentialConnectionApproval(approval)) {
      return {
        once: {
          label: "Connect once",
          description:
            "Save this credential, use it for this request, and ask again before future use.",
        },
        session: {
          label: "Connect this session",
          description: "Save and allow use until NatStack restarts.",
        },
        version: {
          label: trustVersionLabel(approval),
          description: `Save and allow ${exactTrustSubject(approval)} to use it.`,
        },
        repo: {
          label: "Trust repo",
          description: "Save and allow this workspace repo to use it.",
        },
        denyDescription: "Do not connect this service.",
      };
    }
    if (approval.credentialUse === "git-http") {
      const isWrite = approval.gitOperation?.action === "write";
      return {
        once: {
          label: isWrite ? "Push once" : "Read once",
          description: isWrite ? "Allow this git push once." : "Allow this git read once.",
        },
        session: {
          label: isWrite ? "Push this session" : "Read this session",
          description: isWrite
            ? "Allow git pushes to this remote until NatStack restarts."
            : "Allow git reads from this remote until NatStack restarts.",
        },
        version: {
          label: trustVersionLabel(approval),
          description: isWrite
            ? `Allow ${exactTrustSubject(approval)} to push to this remote.`
            : `Allow ${exactTrustSubject(approval)} to read from this remote.`,
        },
        repo: {
          label: "Trust repo",
          description: isWrite
            ? "Allow this workspace project to push to this remote."
            : "Allow this workspace project to read from this remote.",
        },
        denyDescription: isWrite ? "Do not allow this git push." : "Do not allow this git read.",
      };
    }
    return {
      once: {
        label: "Use once",
        description: `Use ${formatCredentialUseTarget(approval)} for this request only.`,
      },
      session: {
        label: "Use this session",
        description: `Reuse ${formatCredentialUseTarget(approval)} until NatStack restarts.`,
      },
      version: {
        label: trustVersionLabel(approval),
        description: `Allow ${exactTrustSubject(approval)} to use ${formatCredentialUseTarget(approval)}.`,
      },
      repo: {
        label: "Trust repo",
        description: `Allow this workspace project to use ${formatCredentialUseTarget(approval)}.`,
      },
      denyDescription: "Do not use this service.",
    };
  }
  if (isOAuthExternalApproval(approval)) {
    return {
      once: { label: "Connect once", description: "Open this sign-in flow once." },
      session: {
        label: "Connect this session",
        description: "Allow this sign-in origin until NatStack restarts.",
      },
      version: {
        label: trustVersionLabel(approval),
        description: `Allow this sign-in origin for ${exactTrustSubject(approval)}.`,
      },
      repo: { label: "Trust repo", description: "Allow this sign-in origin for this workspace." },
      denyDescription: "Do not open this sign-in flow.",
    };
  }
  if (approval.capability === "workspace-repo-write") {
    const isWorkspaceSourceChange = approval.grantResourceKey?.startsWith(
      "workspace-source-change:"
    );
    if (isWorkspaceSourceChange) {
      const destination = approval.resource?.value ?? "this workspace source tree";
      return {
        once: {
          label: "Commit once",
          description: "Allow this workspace source change once.",
        },
        session: {
          label: "Commit this session",
          description: `Allow committed changes to ${destination} until NatStack restarts.`,
        },
        version: {
          label: trustVersionLabel(approval),
          description: `Allow ${trustSubject(approval)} to update ${destination}.`,
        },
        repo: {
          label: "Trust repo",
          description: `Allow this workspace project to update ${destination}.`,
        },
        denyDescription: "Do not allow this workspace source change.",
      };
    }
    const isMeta = approval.resource?.value === "meta";
    return {
      once: {
        label: isMeta ? "Edit once" : "Write once",
        description: isMeta ? "Allow this config push once." : "Allow this git write once.",
      },
      session: {
        label: isMeta ? "Edit this session" : "Write this session",
        description: isMeta
          ? "Allow config pushes until NatStack restarts."
          : "Allow writes to this repository until NatStack restarts.",
      },
      version: {
        label: trustVersionLabel(approval),
        description: isMeta
          ? `Allow ${trustSubject(approval)} to edit workspace config.`
          : `Allow ${trustSubject(approval)} to write to this repository.`,
      },
      repo: {
        label: "Trust repo",
        description: isMeta
          ? "Allow this workspace project to edit workspace config."
          : "Allow this workspace project to write to this repository.",
      },
      denyDescription: isMeta ? "Do not allow this config edit." : "Do not allow this git write.",
    };
  }
  if (approval.capability === "workspace-shared-git-remote") {
    return {
      once: { label: "Change once", description: "Allow this shared remote change once." },
      session: {
        label: "Change this session",
        description: "Allow shared remote changes until NatStack restarts.",
      },
      version: {
        label: trustVersionLabel(approval),
        description: `Allow ${trustSubject(approval)} to change shared remotes.`,
      },
      repo: {
        label: "Trust repo",
        description: "Allow this workspace project to change shared remotes.",
      },
      denyDescription: "Do not change this shared remote.",
    };
  }
  if (approval.capability === "workspace-project-import") {
    return {
      once: { label: "Import once", description: "Allow this project import once." },
      session: {
        label: "Import this session",
        description: "Allow project imports until NatStack restarts.",
      },
      version: {
        label: trustVersionLabel(approval),
        description: `Allow ${trustSubject(approval)} to import project repos.`,
      },
      repo: {
        label: "Trust repo",
        description: "Allow this workspace project to import project repos.",
      },
      denyDescription: "Do not import this project.",
    };
  }
  if (approval.capability === "external-network-fetch") {
    const destination = formatNetworkDestination(approval.resource?.value ?? "this destination");
    return {
      once: {
        label: "Connect once",
        description: "Allow this network request once.",
      },
      session: {
        label: "Allow this origin",
        description: `Allow network requests to ${destination} until NatStack restarts.`,
      },
      version: {
        label: networkTrustLabel(approval),
        description: `Allow ${exactTrustSubject(approval)} to use network access without asking for each origin.`,
      },
      repo: {
        label: "Trust repo with network",
        description:
          "Allow this workspace project to use network access without asking for each origin.",
      },
      denyDescription: `Do not connect to ${destination}.`,
    };
  }
  if (approval.capability === "cors-response-read") {
    const destination = formatNetworkDestination(approval.resource?.value ?? "this destination");
    return {
      once: {
        label: "Read once",
        description: "Allow this cross-origin response read once.",
      },
      session: {
        label: "Read this origin",
        description: `Allow cross-origin response reads from ${destination} until NatStack restarts.`,
      },
      version: {
        label: corsTrustLabel(approval),
        description: `Allow ${exactTrustSubject(approval)} to read cross-origin responses without asking for each origin.`,
      },
      repo: {
        label: "Trust repo with CORS",
        description:
          "Allow this workspace project to read cross-origin responses without asking for each origin.",
      },
      denyDescription: `Do not read responses from ${destination}.`,
    };
  }
  if (isBrowserOpenApproval(approval)) {
    return {
      once: { label: "Open once", description: "Open this browser action once." },
      session: {
        label: "Open this session",
        description: "Allow this browser origin until NatStack restarts.",
      },
      version: {
        label: trustVersionLabel(approval),
        description: `Allow this browser origin for ${exactTrustSubject(approval)}.`,
      },
      repo: { label: "Trust repo", description: "Allow this browser origin for this workspace." },
      denyDescription: "Do not open this site.",
    };
  }
  const target = genericCapabilityTarget(approval);
  return {
    once: { label: "Allow once", description: "Allow this request once." },
    session: {
      label: "Allow this session",
      description: `Allow requests for ${target} until NatStack restarts.`,
    },
    version: {
      label: trustVersionLabel(approval),
      description: `Allow ${exactTrustSubject(approval)} to request ${target}.`,
    },
    repo: {
      label: "Trust repo",
      description: `Allow this workspace project to request ${target}.`,
    },
    denyDescription: `Do not allow ${target}.`,
  };
}

export interface UnitBatchActionCopy {
  once: { label: string; description: string };
  session?: { label: string; description: string };
  deny: { label: string; description: string };
}

export function getUnitBatchActionCopy(approval: PendingUnitBatchApproval): UnitBatchActionCopy {
  const count = approval.units.length;
  const unitLabel = unitBatchLabel(approval).singular;
  const isSourceChange = approval.trigger === "source-change";
  const isManagement = approval.trigger === "management";

  return {
    once: {
      label: isSourceChange
        ? "Approve change"
        : isManagement
          ? "Approve"
          : count > 0
            ? "Approve all"
            : "Allow",
      description: isSourceChange
        ? `Allow this ${unitLabel} source change.`
        : isManagement
          ? `Allow this ${unitLabel} management request.`
          : count > 0
            ? unitBatchApproveDescription(approval, unitLabel)
            : "Apply this workspace config change.",
    },
    ...(approval.trigger === "meta-change" || isSourceChange
      ? {
          session: {
            label: "Dev session",
            description: isSourceChange
              ? `Allow ${unitLabel} source changes without asking again for the next 4 hours.`
              : "Allow workspace-config changes without asking again for the next 4 hours.",
          },
        }
      : {}),
    deny: {
      label: isSourceChange || isManagement ? "Deny" : count > 0 ? "Deny all" : "Deny",
      description: isSourceChange
        ? "Reject this source change."
        : isManagement
          ? "Reject this management request."
          : count > 0
            ? unitLabel === "unit"
              ? "Do not approve these workspace units."
              : `Do not install these ${unitLabel}${count === 1 ? "" : "s"}.`
            : "Reject this workspace config change.",
    },
  };
}

/**
 * The secondary attribution chip: who/what the request runs on behalf of, or
 * the identity it uses. The primary requester (panel/worker/app) is resolved
 * and rendered by the shell from its own semantic caller info — never from a
 * raw id here. This is only the *second* chip, shown as "<relation> <target>".
 */
export interface ApprovalAttribution {
  relation?: "for" | "using" | "with" | "as";
  target?: string;
}

export function getApprovalAttribution(approval: PendingApproval): ApprovalAttribution {
  if (approval.kind === "userland") {
    const issuer = approval.issuer;
    if (issuer && (issuer.kind !== approval.callerKind || issuer.id !== approval.callerId)) {
      return { relation: "for", target: issuer.label ?? prettifyApprovalId(issuer.id) };
    }
    return {};
  }
  if (approval.kind === "credential") {
    // git + non-oauth use: the headline names the destination, so the chip
    // names the credential identity in play. OAuth connect headlines already
    // name the credential, so surface the account instead when we have one.
    if (approval.credentialUse === "git-http") {
      return { relation: "using", target: approval.credentialLabel };
    }
    if (isOAuthCredentialConnectionApproval(approval)) {
      const account = formatAccount(approval);
      return account && account !== approval.credentialId
        ? { relation: "as", target: account }
        : {};
    }
    return { relation: "with", target: formatCredentialUseTarget(approval) };
  }
  return {};
}

/**
 * Headline + (push/bootstrap) summary copy.
 *
 * `title` is the headline: the capability stated in plain language with its
 * object folded in ("Open github.com/foo", "Push to github.com/foo/bar",
 * "Connect Google Calendar"). It carries no requester — attribution is the
 * shell's job (see {@link getApprovalAttribution}).
 *
 * `summary` is a short, requester-free description retained for surfaces that
 * can't render chrome (push notifications, the bootstrap fallback). The shell
 * approval cards no longer render it inline; everything else lives in details.
 */
export function getApprovalCopy(approval: PendingApproval): {
  title: string;
  summary: string;
  warning?: string;
} {
  if (approval.kind === "unit-batch") {
    const count = approval.units.length;
    const unitLabel = unitBatchLabel(approval);
    const fallbackTitle =
      approval.trigger === "management"
        ? `Manage ${count} workspace ${count === 1 ? unitLabel.singular : unitLabel.plural}`
        : approval.trigger === "source-change"
          ? `Update ${unitLabel.singular} source`
          : approval.trigger === "meta-change"
            ? "Apply workspace config change"
            : count > 0
              ? `Run ${count} workspace ${count === 1 ? unitLabel.singular : unitLabel.plural}`
              : "Apply workspace config change";
    const fallbackSummary =
      count > 0
        ? approval.trigger === "management"
          ? `Manages ${count} workspace ${unitLabel.singular}${count === 1 ? "" : "s"}.`
          : approval.trigger === "source-change"
            ? unitLabel.nativeCode
              ? `Updates trusted native extension source code.`
              : `Updates trusted workspace app source code.`
            : `Declares ${count} ${unitLabel.singular}${count === 1 ? "" : "s"} that need approval before they run.`
        : "Changes workspace configuration.";
    return {
      title: approval.title || fallbackTitle,
      summary: approval.description || fallbackSummary,
      ...(count > 0 ? { warning: unitBatchWarning(approval) } : {}),
    };
  }
  if (approval.kind === "capability") {
    if (approval.capability === "workspace-repo-write") {
      const destination = approval.resource?.value ?? "this repository";
      if (approval.grantResourceKey?.startsWith("workspace-source-change:")) {
        return {
          title: `Update ${destination}`,
          summary: `Updates workspace source in ${destination}.`,
        };
      }
      if (destination === "meta") {
        return {
          title: "Edit workspace config",
          summary: "Pushes changes to sensitive workspace config.",
        };
      }
      return {
        title: `Write to ${destination}`,
        summary: `Pushes changes to ${destination}.`,
      };
    }
    if (approval.capability === "workspace-shared-git-remote") {
      const destination = approval.resource?.value ?? "this repository";
      const operation =
        approval.details?.find((detail) => detail.label === "Operation")?.value ??
        "change a shared remote";
      return {
        title: approval.title || `Configure shared remote for ${destination}`,
        summary: `Wants to ${operation.toLowerCase()} for ${destination}.`,
      };
    }
    if (approval.capability === "workspace-project-import") {
      const destination = approval.resource?.value ?? "this project";
      return {
        title: approval.title || `Import ${destination}`,
        summary: `Imports ${destination} from a remote git repository.`,
      };
    }
    if (approval.capability === "external-network-fetch") {
      const destination = formatNetworkDestination(approval.resource?.value ?? "this destination");
      return {
        title: `Connect to ${destination}`,
        summary:
          approval.description ??
          `Makes raw network requests to ${formatNetworkDestination(
            approval.resource?.value ?? "this destination"
          )}.`,
      };
    }
    if (approval.capability === "cors-response-read") {
      const destination = formatNetworkDestination(approval.resource?.value ?? "this destination");
      return {
        title: `Read responses from ${destination}`,
        summary: approval.description ?? `Reads cross-origin responses from ${destination}.`,
      };
    }
    if (approval.capability === "workerd.inspector") {
      const target = approval.resource?.value ?? approval.operation?.object?.value ?? "workerd";
      return {
        title: targetAwareGenericTitle(approval.title, `Inspect ${target}`),
        summary: approval.description ?? `Attaches the workerd inspector to ${target}.`,
      };
    }
    if (approval.capability === "context.boundary") {
      const owner = approval.details?.find((d) => d.label === "Owner")?.value;
      const target =
        approval.resource?.value ?? approval.operation?.object?.value ?? "another context";
      const subject = owner ? `${owner}'s context` : `context ${target}`;
      return {
        title: targetAwareGenericTitle(approval.title, `Act on ${subject}`),
        summary:
          approval.description ??
          `Runs code in / acts on ${subject} — another agent or panel's existing state.`,
        warning: "This runs code in, or acts on, another agent or panel's existing state.",
      };
    }
    if (approval.capability === "client-config-delete") {
      const target = approval.resource?.value ?? "this service configuration";
      return {
        title: targetAwareGenericTitle(approval.title, `Disable ${formatServiceName(target)}`),
        summary: approval.description ?? `Disables ${formatServiceName(target)}.`,
      };
    }
    if (isBrowserOpenApproval(approval)) {
      const isOAuth = isOAuthExternalApproval(approval);
      const destination = formatCapabilityDestination(approval, isOAuth);
      if (isOAuth) {
        return {
          title: `Sign in at ${destination}`,
          summary: `Opens a sign-in flow at ${destination} in your browser.`,
        };
      }
      return {
        title: `Open ${destination}`,
        summary: `Opens ${destination} in your system browser.`,
      };
    }
    const target = genericCapabilityTarget(approval);
    return {
      title: targetAwareGenericTitle(approval.title, `Allow ${target}`),
      summary: approval.description ?? `Requests access to ${target}.`,
    };
  }
  if (approval.kind === "client-config") {
    return {
      title: `Set up ${formatServiceName(approval.configId)}`,
      summary:
        "Saves OAuth client settings. Secrets stay encrypted and are only used for OAuth token exchange and refresh.",
    };
  }
  if (approval.kind === "credential-input") {
    const audience = formatCredentialInputAudienceSummary(approval);
    return {
      title: `Add ${approval.credentialLabel}`,
      summary: `Saves ${approval.credentialLabel} for ${audience}. Secrets stay encrypted and are only sent to matching requests.`,
    };
  }
  if (approval.kind === "userland") {
    // The provider-supplied title IS the headline: it's the decision the user
    // actually needs to scan. The fact that a userland process is asking is
    // demoted to trusted chrome around it (the requester chip) so provider text
    // can describe the request without impersonating the verified-issuer chrome.
    const subjectName = approval.subject.label ?? approval.subject.id;
    return {
      title: approval.title,
      summary: approval.summary ?? `Decision about ${subjectName}.`,
      warning: approval.warning,
    };
  }
  if (approval.kind === "device-code") {
    return {
      title: `Sign in to ${approval.credentialLabel}`,
      summary:
        `Enter code ${approval.userCode} at ${originForUrl(approval.verificationUri)} ` +
        `to finish connecting ${approval.credentialLabel}.`,
    };
  }

  const audience = formatAudienceSummary(approval);
  if (approval.credentialUse === "git-http") {
    const operation = approval.gitOperation;
    const remote = operation?.remote ? formatGitRemoteSummary(operation.remote) : audience;
    const label = operation?.label ?? "git operation";
    return {
      title: operation?.action === "write" ? `Push to ${remote}` : `Read from ${remote}`,
      summary: `Wants to ${label} on ${remote} using ${approval.credentialLabel}.`,
    };
  }
  if (isOAuthCredentialConnectionApproval(approval)) {
    return {
      title: `Connect ${approval.credentialLabel}`,
      summary: approval.replacementCredentialLabel
        ? `Replaces your existing ${approval.replacementCredentialLabel} credential with ${approval.credentialLabel} for ${audience}.`
        : `Connects ${approval.credentialLabel} for ${audience}.`,
      warning: approval.oauthAudienceDomainMismatch
        ? "The sign-in domain differs from the service domain."
        : undefined,
    };
  }
  return {
    title: `Use ${approval.bindingLabel ?? approval.credentialLabel}`,
    summary: `Uses ${approval.credentialLabel} with ${formatCredentialUseTarget(approval)}.`,
    warning: approval.oauthAudienceDomainMismatch
      ? "The sign-in domain differs from the service domain."
      : undefined,
  };
}

function userlandCallerKindLabel(kind: "panel" | "app" | "worker" | "do" | "system"): string {
  switch (kind) {
    case "panel":
      return "Panel";
    case "app":
      return "App";
    case "worker":
      return "Worker";
    case "do":
      return "DO";
    case "system":
      return "Workspace";
  }
}

export function getCapabilityPrimaryDestination(approval: PendingCapabilityApproval): string {
  return (
    approval.details?.find((detail) => detail.label.toLowerCase() === "url")?.value ??
    approval.resource?.value ??
    "an external destination"
  );
}

export function shouldOpenApprovalDetails(approval: PendingApproval): boolean {
  return approval.kind === "unit-batch";
}

function isBrowserOpenApproval(approval: PendingCapabilityApproval): boolean {
  return approval.capability === "external-browser-open" || approval.capability === "open-url";
}

function genericCapabilityTarget(approval: PendingCapabilityApproval): string {
  return (
    approval.operation?.object?.value ??
    approval.resource?.value ??
    approval.details?.find((detail) => detail.label.toLowerCase() === "target")?.value ??
    approval.details?.find((detail) => detail.label.toLowerCase() === "target origin")?.value ??
    approval.capability
  );
}

function targetAwareGenericTitle(title: string | undefined, fallback: string): string {
  if (!title) return fallback;
  const normalized = title.trim().toLowerCase();
  const genericTitles = new Set([
    "allow network access",
    "allow cross-origin response access",
    "create runtime entity in another context",
    "disable service configuration",
    "profile workers via the workerd inspector",
  ]);
  return genericTitles.has(normalized) ? fallback : title;
}

function unitBatchLabel(approval: PendingUnitBatchApproval): {
  singular: string;
  plural: string;
  nativeCode: boolean;
  scheduledJob: boolean;
} {
  const hasExtensions = approval.units.some((unit) => unit.unitKind === "extension");
  const hasApps = approval.units.some((unit) => unit.unitKind === "app");
  const hasScheduledJobs = approval.units.some((unit) => unit.unitKind === "scheduled-job");
  const hasAgentHeartbeats = approval.units.some((unit) => unit.unitKind === "agent-heartbeat");
  if (hasExtensions && !hasApps && !hasScheduledJobs && !hasAgentHeartbeats) {
    return { singular: "extension", plural: "extensions", nativeCode: true, scheduledJob: false };
  }
  if (hasApps && !hasExtensions && !hasScheduledJobs && !hasAgentHeartbeats) {
    return { singular: "app", plural: "apps", nativeCode: false, scheduledJob: false };
  }
  if (hasScheduledJobs && !hasApps && !hasExtensions && !hasAgentHeartbeats) {
    return {
      singular: "scheduled job",
      plural: "scheduled jobs",
      nativeCode: false,
      scheduledJob: true,
    };
  }
  if (hasAgentHeartbeats && !hasApps && !hasExtensions && !hasScheduledJobs) {
    return {
      singular: "agent heartbeat",
      plural: "agent heartbeats",
      nativeCode: false,
      scheduledJob: true,
    };
  }
  return {
    singular: "unit",
    plural: "units",
    nativeCode: hasExtensions,
    scheduledJob: hasScheduledJobs,
  };
}

function unitBatchWarning(approval: PendingUnitBatchApproval): string {
  const hasExtensions = approval.units.some((unit) => unit.unitKind === "extension");
  const hasApps = approval.units.some((unit) => unit.unitKind === "app");
  const hasScheduledJobs = approval.units.some((unit) => unit.unitKind === "scheduled-job");
  const hasAgentHeartbeats = approval.units.some((unit) => unit.unitKind === "agent-heartbeat");
  const warnings: string[] = [];
  if (hasExtensions) {
    warnings.push("runs native code with filesystem, network, and process access");
  }
  if (hasApps) {
    warnings.push("allows these workspace apps to run in the app host");
  }
  if (hasScheduledJobs) {
    warnings.push("allows these scheduled jobs to run automatically");
  }
  if (hasAgentHeartbeats) {
    warnings.push("allows these agent heartbeats to run unattended and invoke agent tools");
  }
  if (warnings.length === 1) return `Approving ${warnings[0]}.`;
  if (warnings.length === 0) return "Approving these workspace units.";
  return `Approving ${warnings.slice(0, -1).join("; ")}; and ${warnings[warnings.length - 1]}.`;
}

function unitBatchUnitKinds(approval: PendingUnitBatchApproval): string[] {
  const kinds: string[] = [];
  if (approval.units.some((unit) => unit.unitKind === "extension")) {
    kinds.push("native extensions");
  }
  if (approval.units.some((unit) => unit.unitKind === "app")) {
    kinds.push("workspace apps");
  }
  if (approval.units.some((unit) => unit.unitKind === "scheduled-job")) {
    kinds.push("scheduled jobs");
  }
  if (approval.units.some((unit) => unit.unitKind === "agent-heartbeat")) {
    kinds.push("agent heartbeats");
  }
  return kinds;
}

function unitBatchApproveDescription(
  approval: PendingUnitBatchApproval,
  unitLabel: string
): string {
  const count = approval.units.length;
  if (unitLabel === "scheduled job") {
    return `Approve ${count} scheduled job${count === 1 ? "" : "s"} to run automatically.`;
  }
  if (unitLabel === "agent heartbeat") {
    return `Approve ${count} agent heartbeat${count === 1 ? "" : "s"} to run unattended.`;
  }
  if (unitLabel === "unit") {
    const kinds = unitBatchUnitKinds(approval);
    return `Approve ${count} workspace units${kinds.length > 0 ? ` (${kinds.join(", ")})` : ""}.`;
  }
  const hasExtensions = approval.units.some((unit) => unit.unitKind === "extension");
  return `Install and run ${count} ${unitLabel}${count === 1 ? "" : "s"}${hasExtensions ? " as native code" : ""}.`;
}

export function originForUrl(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

export function formatAudienceSummary(approval: PendingCredentialApproval): string {
  if (approval.audience.length === 0) return "an unspecified audience";
  const first = approval.audience[0];
  if (!first) return "an unspecified audience";
  const audience = formatUrlForSummary(first.url, first.match === "origin" ? "origin" : "path");
  const extraCount = approval.audience.length - 1;
  return extraCount > 0 ? `${audience} and ${extraCount} more` : audience;
}

export function formatCredentialUseTarget(approval: PendingCredentialApproval): string {
  if (approval.grantResource?.resource) {
    const resource = formatCredentialGrantResourceSummary(approval.grantResource.resource);
    return approval.bindingLabel ? `${approval.bindingLabel} at ${resource}` : resource;
  }
  if (approval.bindingLabel) {
    return approval.bindingLabel;
  }
  return formatAudienceSummary(approval);
}

function formatCredentialGrantResourceSummary(raw: string): string {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      (url.hostname === "api.github.com" || url.hostname === "uploads.github.com") &&
      segments[0] === "repos" &&
      segments[1] &&
      segments[2]
    ) {
      return `github.com/${segments[1]}/${segments[2]}`;
    }
  } catch {
    // fall through to generic formatting
  }
  return formatUrlForSummary(raw, "path");
}

export function formatGitRemoteSummary(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    return path ? `${url.hostname}/${path}` : url.hostname;
  } catch {
    return raw;
  }
}

export function formatAccount(approval: PendingCredentialApproval): string {
  const identity = approval.accountIdentity;
  return (
    identity.email ??
    identity.username ??
    identity.workspaceName ??
    identity.providerUserId ??
    approval.credentialId
  );
}

export function formatCredentialInputAudienceSummary(
  approval: PendingCredentialInputApproval
): string {
  if (approval.audience.length === 0) return "this service";
  const first = approval.audience[0];
  if (!first) return "this service";
  const audience = formatUrlForSummary(first.url, first.match === "origin" ? "origin" : "path");
  const extraCount = approval.audience.length - 1;
  return extraCount > 0 ? `${audience} and ${extraCount} more` : audience;
}

export function formatInjection(
  approval: PendingCredentialApproval | PendingCredentialInputApproval
): string {
  const injection = approval.injection;
  if (injection.type === "query-param") {
    return `query ${injection.name}`;
  }
  if (injection.type === "basic-auth") {
    return "basic auth";
  }
  if (injection.type === "oauth1-signature") {
    return "OAuth 1 signature";
  }
  if (injection.type === "cookie") {
    return "cookie";
  }
  if (injection.type === "aws-sigv4") {
    return `AWS SigV4 ${injection.service}/${injection.region}`;
  }
  if (injection.type === "ssh-key") {
    return "SSH key";
  }
  return `header ${injection.name}`;
}

export function isOAuthCredentialConnectionApproval(approval: PendingCredentialApproval): boolean {
  return !!approval.oauthAuthorizeOrigin && !!approval.oauthTokenOrigin && !approval.credentialUse;
}

export function isOAuthExternalApproval(approval: PendingCapabilityApproval): boolean {
  return (
    approval.details?.some((detail) => detail.label.toLowerCase() === "oauth callback") === true
  );
}

export function formatCapabilityDestination(
  approval: PendingCapabilityApproval,
  oauth: boolean
): string {
  const rawDestination = getCapabilityPrimaryDestination(approval);
  return formatUrlForSummary(rawDestination, oauth ? "origin" : "path");
}

export function formatNetworkDestination(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "mailto:") {
      return "email";
    }
    const host = url.host || url.hostname;
    const path = compactPath(url.pathname);
    return path ? `${host}${path}` : host;
  } catch {
    return raw.length > 64 ? `${raw.slice(0, 61)}...` : raw;
  }
}

export function formatUrlForSummary(raw: string, mode: "origin" | "path" = "path"): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "mailto:") {
      return "email";
    }
    const host = url.hostname;
    if (mode === "origin") {
      return host;
    }
    const path = compactPath(url.pathname);
    return path ? `${host}${path}` : host;
  } catch {
    return raw.length > 64 ? `${raw.slice(0, 61)}...` : raw;
  }
}

export function compactPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  const first = segments[0] ?? "";
  if (!first || first.length > 32) {
    return "";
  }
  return `/${first}${segments.length > 1 ? "/..." : ""}`;
}

export function formatServiceName(configId: string): string {
  return (
    configId
      .split(/[-_.]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "this service"
  );
}
