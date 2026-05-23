import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { ApprovalSheet } from "./ApprovalSheet";
import type { PendingApproval } from "@natstack/shared/approvals";

const base = {
  approvalId: "approval-1",
  callerId: "worker-abcdef123456",
  callerKind: "worker",
  repoPath: "/projects/foo",
  effectiveVersion: "v1",
  requestedAt: 1,
} as const;

const capability: PendingApproval = {
  ...base,
  kind: "capability",
  capability: "open-url",
  title: "Open URL",
  resource: { type: "url", label: "URL", value: "https://github.com/foo/bar" },
  details: [{ label: "URL", value: "https://github.com/foo/bar" }],
};

const credential: PendingApproval = {
  ...base,
  kind: "credential",
  credentialId: "cred-google",
  credentialLabel: "Google Calendar",
  audience: [{ match: "origin", url: "https://calendar.google.com/" }],
  injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {{token}}" },
  accountIdentity: { email: "me@example.com", providerUserId: "user-1" },
  scopes: ["calendar.readonly"],
  oauthAuthorizeOrigin: "https://accounts.google.com",
  oauthTokenOrigin: "https://oauth2.googleapis.com",
  oauthAudienceDomainMismatch: true,
};

const clientConfig: PendingApproval = {
  ...base,
  kind: "client-config",
  configId: "google-calendar",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  title: "Google Calendar",
  fields: [
    { name: "clientId", label: "Client ID", type: "text", required: true },
    { name: "clientSecret", label: "Client Secret", type: "secret", required: true },
  ],
};

const credentialInput: PendingApproval = {
  ...base,
  kind: "credential-input",
  title: "Add API key",
  credentialLabel: "Acme API",
  audience: [{ match: "path-prefix", url: "https://api.acme.test/v1/projects" }],
  injection: { type: "query-param", name: "api_key" },
  accountIdentity: { providerUserId: "acme-user" },
  scopes: ["projects.read"],
  fields: [{ name: "apiKey", label: "API Key", type: "secret", required: true }],
};

const userland: PendingApproval = {
  ...base,
  kind: "userland",
  subject: { id: "team-x:foo", label: "Foo" },
  title: "Allow foo?",
  summary: "Team X is requesting access to foo.",
  details: [{ label: "Reason", value: "continue work" }],
  promptOptions: "choices",
  options: [
    { value: "allow", label: "Allow", tone: "primary" },
    { value: "deny", label: "Deny", tone: "danger" },
    { value: "later", label: "Later", tone: "neutral" },
  ],
};

function renderSheet(
  approval: PendingApproval | PendingApproval[],
  overrides: Partial<React.ComponentProps<typeof ApprovalSheet>> = {}
) {
  const props = {
    approvals: Array.isArray(approval) ? approval : [approval],
    onResolve: jest.fn(async () => undefined),
    onSubmitClientConfig: jest.fn(async () => undefined),
    onSubmitCredentialInput: jest.fn(async () => undefined),
    onResolveUserland: jest.fn(async () => undefined),
    ...overrides,
  };
  const view = render(<ApprovalSheet {...props} />);
  return { ...view, props };
}

describe("ApprovalSheet", () => {
  it.each([
    [capability, "Open external site"],
    [credential, "Connect service"],
    [clientConfig, "Configure service"],
    [credentialInput, "Add service"],
    [userland, "Worker requests your decision"],
  ] as const)("renders %s", (approval, title) => {
    const { getByText } = renderSheet(approval);
    expect(getByText(title)).toBeTruthy();
  });

  it.each(["once", "session", "version", "deny"] as const)(
    "resolves standard decision %s",
    async (decision) => {
      const onResolve = jest.fn(async () => undefined);
      const { getByTestId } = renderSheet(capability, { onResolve });

      fireEvent.press(getByTestId(`approval-action-${decision}`));

      await waitFor(() => expect(onResolve).toHaveBeenCalledWith("approval-1", decision));
    }
  );

  it("submits client config only after required fields are filled", async () => {
    const onSubmitClientConfig = jest.fn(async () => undefined);
    const { getByTestId } = renderSheet(clientConfig, { onSubmitClientConfig });

    fireEvent.press(getByTestId("approval-submit"));
    expect(onSubmitClientConfig).not.toHaveBeenCalled();

    fireEvent.changeText(getByTestId("approval-field-clientId"), "client-id");
    fireEvent.changeText(getByTestId("approval-field-clientSecret"), "secret");
    fireEvent.press(getByTestId("approval-submit"));

    await waitFor(() =>
      expect(onSubmitClientConfig).toHaveBeenCalledWith("approval-1", {
        clientId: "client-id",
        clientSecret: "secret",
      })
    );
  });

  it("submits credential input only after required fields are filled", async () => {
    const onSubmitCredentialInput = jest.fn(async () => undefined);
    const { getByTestId } = renderSheet(credentialInput, { onSubmitCredentialInput });

    fireEvent.press(getByTestId("approval-submit"));
    expect(onSubmitCredentialInput).not.toHaveBeenCalled();

    fireEvent.changeText(getByTestId("approval-field-apiKey"), "github_pat_1");
    fireEvent.press(getByTestId("approval-submit"));

    await waitFor(() =>
      expect(onSubmitCredentialInput).toHaveBeenCalledWith("approval-1", {
        apiKey: "github_pat_1",
      })
    );
  });

  it("renders OAuth mismatch warning conditionally", () => {
    const { getByText, queryByText, rerender } = renderSheet(credential);
    expect(getByText("The sign-in domain differs from the service domain.")).toBeTruthy();

    rerender(
      <ApprovalSheet
        approvals={[{ ...credential, oauthAudienceDomainMismatch: false }]}
        onResolve={jest.fn()}
        onSubmitClientConfig={jest.fn()}
        onSubmitCredentialInput={jest.fn()}
        onResolveUserland={jest.fn()}
      />
    );
    expect(queryByText("The sign-in domain differs from the service domain.")).toBeNull();
  });

  it("resolves userland options and renders verified issuer chrome", async () => {
    const onResolveUserland = jest.fn(async () => undefined);
    const { getByText, getByTestId } = renderSheet(userland, { onResolveUserland });

    expect(getByText("Worker request")).toBeTruthy();
    expect(getByText(/Remembered for worker/)).toBeTruthy();

    fireEvent.press(getByTestId("approval-userland-allow"));
    await waitFor(() => expect(onResolveUserland).toHaveBeenCalledWith("approval-1", "allow"));
  });

  it("renders the caller chip with the kind icon and label", () => {
    const titledPanel: PendingApproval = {
      ...base,
      callerKind: "panel",
      callerTitle: "My Project",
      kind: "capability",
      capability: "open-url",
      title: "Open URL",
      resource: { type: "url", label: "URL", value: "https://example.com" },
    };
    const { getByText, getByTestId } = renderSheet(titledPanel);
    expect(getByTestId("approval-caller-chip")).toBeTruthy();
    expect(getByText("My Project")).toBeTruthy();
    expect(getByText("Requested by")).toBeTruthy();
  });

  it("calls onNavigateToPanel when the caller is a panel and the chip is pressed", () => {
    const titledPanel: PendingApproval = {
      ...base,
      callerId: "panel:abc",
      callerKind: "panel",
      callerTitle: "Spectrolite",
      kind: "userland",
      subject: { id: "subj-1", label: "Foo" },
      title: "Allow foo?",
      promptOptions: "choices",
      options: [{ value: "allow", label: "Allow", tone: "primary" }],
    };
    const onNavigateToPanel = jest.fn();
    const { getByTestId } = renderSheet(titledPanel, { onNavigateToPanel });
    fireEvent.press(getByTestId("approval-caller-chip"));
    expect(onNavigateToPanel).toHaveBeenCalledWith("panel:abc");
  });

  it("steps through a queue of pending approvals", () => {
    const a: PendingApproval = {
      ...base,
      approvalId: "a1",
      kind: "userland",
      subject: { id: "s-1" },
      title: "First request",
      promptOptions: "choices",
      options: [{ value: "ok", label: "OK", tone: "primary" }],
    };
    const b: PendingApproval = { ...a, approvalId: "a2", title: "Second request" };
    const c: PendingApproval = { ...a, approvalId: "a3", title: "Third request" };
    const { getByText, getByTestId } = renderSheet([a, b, c]);
    expect(getByText("First request")).toBeTruthy();
    expect(getByText("1 / 3")).toBeTruthy();
    fireEvent.press(getByTestId("approval-queue-next"));
    expect(getByText("Second request")).toBeTruthy();
    expect(getByText("2 / 3")).toBeTruthy();
    fireEvent.press(getByTestId("approval-queue-prev"));
    expect(getByText("First request")).toBeTruthy();
  });

  it("uses userland tone variants", () => {
    const { getByTestId } = renderSheet(userland);

    expect(getByTestId("approval-userland-allow").props.accessibilityLabel).toContain("Allow");
    expect(getByTestId("approval-userland-deny").props.accessibilityLabel).toContain("Deny");
    expect(getByTestId("approval-userland-later").props.accessibilityLabel).toContain("Later");
  });

  it("dismisses from backdrop and uses userland dismiss RPC", async () => {
    const onResolveUserland = jest.fn(async () => undefined);
    const { getByTestId } = renderSheet(userland, { onResolveUserland });

    fireEvent.press(getByTestId("approval-backdrop"));

    await waitFor(() => expect(onResolveUserland).toHaveBeenCalledWith("approval-1", "dismiss"));
  });

  it("replaces sheet content when approval id changes", () => {
    const { getByText, rerender } = renderSheet(capability);
    expect(getByText("Open external site")).toBeTruthy();

    rerender(
      <ApprovalSheet
        approvals={[{ ...credentialInput, approvalId: "approval-2" }]}
        onResolve={jest.fn()}
        onSubmitClientConfig={jest.fn()}
        onSubmitCredentialInput={jest.fn()}
        onResolveUserland={jest.fn()}
      />
    );
    expect(getByText("Add service")).toBeTruthy();
  });

  it("shows inline error when resolve fails", async () => {
    const onResolve = jest.fn(async () => {
      throw new Error("boom");
    });
    const { getByTestId, getByText } = renderSheet(capability, { onResolve });

    fireEvent.press(getByTestId("approval-action-once"));

    await waitFor(() => expect(getByText("boom")).toBeTruthy());
  });
});
