import type {
  PendingApproval,
  PendingCapabilityApproval,
  PendingCredentialApproval,
  PendingCredentialInputApproval,
  PendingDeviceCodeApproval,
  PendingExtensionApproval,
} from "./approvals.js";

function truncateId(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
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
    return approval.callerKind === "worker" ? "Worker request" : "Panel request";
  }
  if (approval.kind === "device-code") {
    return "Device sign-in";
  }
  if (approval.kind === "extension") {
    return approval.action === "source-push" ? "Extension source" : "Extension management";
  }
  if (approval.capability === "internal-git-write") {
    return approval.resource?.value === "meta" ? "Config edit" : "Write request";
  }
  if (approval.capability === "workspace-shared-git-remote") {
    return "Remote config";
  }
  if (approval.capability === "workspace-project-import") {
    return "Project import";
  }
  if (approval.capability === "extension-source-push") {
    return "Extension source";
  }
  if (approval.capability === "extension-management") {
    return "Extension management";
  }
  return isOAuthExternalApproval(approval) ? "Sign-in action" : "Browser action";
}

export function getStandardActionCopy(
  approval: PendingCredentialApproval | PendingCapabilityApproval | PendingExtensionApproval
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
          label: "Trust version",
          description: "Save and allow this exact stable code version to use it.",
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
          label: "Trust version",
          description: isWrite
            ? "Allow this exact code version to push to this remote."
            : "Allow this exact code version to read from this remote.",
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
      once: { label: "Use once", description: "Use this service for this request only." },
      session: {
        label: "Use this session",
        description: "Reuse this service until NatStack restarts.",
      },
      version: {
        label: "Trust version",
        description: "Reuse this service for this exact code version.",
      },
      repo: { label: "Trust repo", description: "Reuse this service for this workspace." },
      denyDescription: "Do not use this service.",
    };
  }
  if (approval.kind === "extension") {
    if (approval.action === "source-push") {
      return {
        once: { label: "Allow push", description: "Allow this extension source push once." },
        session: {
          label: "Allow dev session",
          description: `Allow pushes to ${approval.extensionName} without asking for the next 4 hours.`,
        },
        version: {
          label: "Trust version",
          description: "Allow this code version to push this extension source.",
        },
        repo: {
          label: "Trust repo",
          description: "Allow this workspace project to push this extension source.",
        },
        denyDescription: "Reject this extension source push.",
      };
    }
    if (approval.action === "install") {
      return {
        once: { label: "Install and run", description: "Install and run this extension once." },
        session: {
          label: "Allow this session",
          description: "Allow extension installs until NatStack restarts.",
        },
        version: {
          label: "Trust version",
          description: "Allow this code version to install extensions.",
        },
        repo: {
          label: "Trust repo",
          description: "Allow this workspace project to install extensions.",
        },
        denyDescription: "Don't install this extension.",
      };
    }
    if (approval.action === "update") {
      return {
        once: { label: "Update and run", description: "Update and run this extension once." },
        session: {
          label: "Allow this session",
          description: "Allow extension updates until NatStack restarts.",
        },
        version: {
          label: "Trust version",
          description: "Allow this code version to update extensions.",
        },
        repo: {
          label: "Trust repo",
          description: "Allow this workspace project to update extensions.",
        },
        denyDescription: "Cancel this extension update.",
      };
    }
    const action = approval.action === "toggle" ? "change" : approval.action;
    return {
      once: { label: "Allow once", description: `Allow this extension ${action} once.` },
      session: {
        label: "Allow this session",
        description: "Allow extension management until NatStack restarts.",
      },
      version: {
        label: "Trust version",
        description: "Allow this code version to manage extensions.",
      },
      repo: {
        label: "Trust repo",
        description: "Allow this workspace project to manage extensions.",
      },
      denyDescription: "Do not manage this extension.",
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
        label: "Trust version",
        description: "Allow this sign-in origin for this exact code version.",
      },
      repo: { label: "Trust repo", description: "Allow this sign-in origin for this workspace." },
      denyDescription: "Do not open this sign-in flow.",
    };
  }
  if (approval.capability === "internal-git-write") {
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
        label: "Trust version",
        description: isMeta
          ? "Allow this code version to edit workspace config."
          : "Allow this code version to write to this repository.",
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
        label: "Trust version",
        description: "Allow this code version to change shared remotes.",
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
        label: "Trust version",
        description: "Allow this code version to import project repos.",
      },
      repo: {
        label: "Trust repo",
        description: "Allow this workspace project to import project repos.",
      },
      denyDescription: "Do not import this project.",
    };
  }
  if (approval.capability === "extension-source-push") {
    const name = approval.resource?.value ?? "this extension";
    return {
      once: { label: "Allow push", description: "Allow this extension source push once." },
      session: {
        label: "Allow dev session",
        description: `Allow extension pushes to ${name} without asking for the next 4 hours.`,
      },
      version: {
        label: "Trust version",
        description: "Allow this code version to push this extension source.",
      },
      repo: {
        label: "Trust repo",
        description: "Allow this workspace project to push this extension source.",
      },
      denyDescription: "Reject this extension source push.",
    };
  }
  if (approval.capability === "extension-management") {
    return {
      once: { label: "Allow once", description: "Allow this extension management action once." },
      session: {
        label: "Allow this session",
        description: "Allow extension management until NatStack restarts.",
      },
      version: {
        label: "Trust version",
        description: "Allow this code version to manage extensions.",
      },
      repo: {
        label: "Trust repo",
        description: "Allow this workspace project to manage extensions.",
      },
      denyDescription: "Do not manage this extension.",
    };
  }
  return {
    once: { label: "Open once", description: "Open this browser action once." },
    session: {
      label: "Open this session",
      description: "Allow this browser origin until NatStack restarts.",
    },
    version: {
      label: "Trust version",
      description: "Allow this browser origin for this exact code version.",
    },
    repo: { label: "Trust repo", description: "Allow this browser origin for this workspace." },
    denyDescription: "Do not open this site.",
  };
}

export function getApprovalCopy(
  approval: PendingApproval,
  callerLabel: string
): { title: string; summary: string; warning?: string } {
  const requester = `${callerLabel} ${truncateId(approval.callerId)}`;
  if (approval.kind === "extension") {
    const action =
      approval.action === "source-push"
        ? "update trusted source for"
        : approval.action === "toggle"
          ? "change the enabled state of"
          : `${approval.action}`;
    return {
      title: approval.title || "Manage extension",
      summary: `${requester} wants to ${action} ${approval.extensionName}.`,
      warning:
        "Approving this can run Node extension code with filesystem, network, and process access.",
    };
  }
  if (approval.kind === "capability") {
    if (approval.capability === "internal-git-write") {
      const destination = approval.resource?.value ?? "this repository";
      if (destination === "meta") {
        return {
          title: "Edit workspace config",
          summary: `${requester} wants to push changes to sensitive workspace config.`,
        };
      }
      return {
        title: "Write project files",
        summary: `${requester} wants to push changes to ${destination}.`,
      };
    }
    if (approval.capability === "workspace-shared-git-remote") {
      const destination = approval.resource?.value ?? "this repository";
      const operation =
        approval.details?.find((detail) => detail.label === "Operation")?.value ??
        "change a shared remote";
      return {
        title: approval.title || "Configure shared remote",
        summary: `${requester} wants to ${operation.toLowerCase()} for ${destination}.`,
      };
    }
    if (approval.capability === "workspace-project-import") {
      const destination = approval.resource?.value ?? "this project";
      return {
        title: approval.title || "Add project repo",
        summary: `${requester} wants to import ${destination} from a remote git repository.`,
      };
    }
    if (approval.capability === "extension-source-push") {
      const destination = approval.resource?.value ?? "this extension";
      return {
        title: approval.title || `${destination} source push`,
        summary: `${requester} wants to update trusted native extension code for ${destination}.`,
        warning:
          "Accepting this push runs updated Node code with filesystem, network, and process access.",
      };
    }
    if (approval.capability === "extension-management") {
      const destination = approval.resource?.value ?? "this extension";
      return {
        title: approval.title || "Manage extension",
        summary: `${requester} wants to manage ${destination}, which can run native Node code.`,
      };
    }
    const isOAuth = isOAuthExternalApproval(approval);
    const destination = formatCapabilityDestination(approval, isOAuth);
    if (isOAuth) {
      return {
        title: "Connect to service",
        summary: `${requester} wants to connect to ${destination} in your browser.`,
      };
    }
    return {
      title: "Open external site",
      summary: `${requester} wants to open ${destination} in your system browser.`,
    };
  }
  if (approval.kind === "client-config") {
    return {
      title: "Configure service",
      summary:
        "Save OAuth client settings. Secrets stay encrypted and are only used for OAuth token exchange and refresh.",
    };
  }
  if (approval.kind === "credential-input") {
    const audience = formatCredentialInputAudienceSummary(approval);
    return {
      title: "Add service",
      summary: `${requester} wants to save ${approval.credentialLabel} for ${audience}. Secrets stay encrypted and are only sent to matching requests.`,
    };
  }
  if (approval.kind === "userland") {
    // Header text is renderer-controlled. Provider-supplied title, summary,
    // and warning render inside the "From <issuer>" framed body so they
    // cannot impersonate the verified-issuer chrome.
    const callerKindLabel = approval.callerKind === "worker" ? "Worker" : "Panel";
    const issuer = approval.issuer;
    const issuerDiffers = issuer && (issuer.kind !== approval.callerKind || issuer.id !== approval.callerId);
    if (issuerDiffers && issuer) {
      const issuerLabel = `${issuer.kind} ${truncateId(issuer.id)}`;
      return {
        title: `${callerKindLabel} requests your decision`,
        summary: `${requester} is being asked by ${issuerLabel} about ${approval.subject.id}. Your choice will be remembered until revoked.`,
      };
    }
    return {
      title: `${callerKindLabel} requests your decision`,
      summary: `${requester} is asking about ${approval.subject.id}. Your choice will be remembered until revoked.`,
    };
  }
  if (approval.kind === "device-code") {
    return {
      title: `Sign in to ${approval.credentialLabel}`,
      summary:
        `Enter code ${approval.userCode} at ${originForUrl(approval.verificationUri)} `
        + `to finish connecting ${approval.credentialLabel}. `
        + `${requester} initiated this request.`,
    };
  }

  const audience = formatAudienceSummary(approval);
  if (approval.credentialUse === "git-http") {
    const operation = approval.gitOperation;
    const remote = operation?.remote ? formatGitRemoteSummary(operation.remote) : audience;
    const label = operation?.label ?? "git operation";
    return {
      title: operation?.action === "write" ? "Push to remote" : "Read from remote",
      summary: `${requester} wants to ${label} on ${remote} using ${approval.credentialLabel}.`,
    };
  }
  if (isOAuthCredentialConnectionApproval(approval)) {
    return {
      title: "Connect service",
      summary: approval.replacementCredentialLabel
        ? `${requester} wants to replace your existing ${approval.replacementCredentialLabel} credential with ${approval.credentialLabel} and use it with ${audience}.`
        : `${requester} wants to connect ${approval.credentialLabel} and use it with ${audience}.`,
      warning: approval.oauthAudienceDomainMismatch
        ? "The sign-in domain differs from the service domain."
        : undefined,
    };
  }
  return {
    title: "Use connected service",
    summary: `${requester} wants to use ${approval.credentialLabel} with ${audience}.`,
    warning: approval.oauthAudienceDomainMismatch
      ? "The sign-in domain differs from the service domain."
      : undefined,
  };
}

export function getCapabilityPrimaryDestination(approval: PendingCapabilityApproval): string {
  return (
    approval.details?.find((detail) => detail.label.toLowerCase() === "url")?.value ??
    approval.resource?.value ??
    "an external destination"
  );
}

export function shouldOpenApprovalDetails(approval: PendingApproval): boolean {
  return approval.kind === "extension";
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
