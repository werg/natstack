/**
 * Model Provider Config Page - Shell panel for AI provider configuration.
 *
 * This is a shell panel with full access to shell services. It exposes the
 * OAuth login flow for subscription providers (e.g. ChatGPT) and a read-only
 * status view for environment-variable providers. The legacy API-key entry
 * flow has been removed — see W1h/W1j of the humming-noodling-pnueli refactor.
 */

import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import { Theme } from "@radix-ui/themes";
import { rpc } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";

interface ProviderStatus {
  id: string;
      kind: "oauth" | "env";
  status: "connected" | "disconnected" | "configured" | "unconfigured";
  name: string;
  envVar?: string;
}

function ModelProviderConfigPage() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = await rpc.call<ProviderStatus[]>("main", "credentialFlow.listProviders");
    setProviders(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleConnect = async (providerId: string) => {
    setConnecting(providerId);
    try {
      const result = await rpc.call<{ success: boolean; error?: string }>(
        "main",
        "credentialFlow.connect",
        providerId,
      );
      if (result && !result.success) {
        alert(`Login failed: ${result.error ?? "unknown error"}`);
      }
      await refresh();
    } catch (err) {
      alert(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConnecting(null);
    }
  };

  const handleDisconnect = async (providerId: string) => {
    try {
      await rpc.call<void>("main", "credentialFlow.disconnect", providerId);
      await refresh();
    } catch (err) {
      alert(`Disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: "1.5rem" }}>
        <p>Loading…</p>
      </div>
    );
  }

  const oauthProviders = providers.filter((p) => p.kind === "oauth");
  const envProviders = providers.filter((p) => p.kind === "env");

  return (
    <div
      style={{
        padding: "1.5rem",
        maxWidth: "720px",
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>
          AI provider configuration
        </h1>
        <p style={{ fontSize: "0.875rem", opacity: 0.75, margin: 0 }}>
          Connect to a subscription service (no per-token API costs) or set
          environment variables for raw API keys (pay-per-token, dev only).
        </p>
      </header>

      <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h2 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>
          Subscription providers (OAuth)
        </h2>
        {oauthProviders.length === 0 ? (
          <p style={{ fontSize: "0.875rem", opacity: 0.75, margin: 0 }}>
            No OAuth providers available.
          </p>
        ) : (
          oauthProviders.map((p) => (
            <ProviderRow
              key={p.id}
              status={p}
              connecting={connecting === p.id}
              onConnect={() => handleConnect(p.id)}
              onDisconnect={() => handleDisconnect(p.id)}
            />
          ))
        )}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h2 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>
          Environment variable providers
        </h2>
        {envProviders.length === 0 ? (
          <p style={{ fontSize: "0.875rem", opacity: 0.75, margin: 0 }}>
            No environment-variable providers available.
          </p>
        ) : (
          envProviders.map((p) => <EnvProviderRow key={p.id} status={p} />)
        )}
      </section>
    </div>
  );
}

interface ProviderRowProps {
  status: ProviderStatus;
  connecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}

function ProviderRow({ status, connecting, onConnect, onDisconnect }: ProviderRowProps) {
  const isConnected = status.status === "connected";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
        border: "1px solid var(--gray-a5, rgba(0,0,0,0.15))",
        borderRadius: "8px",
        padding: "1rem",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <div style={{ fontWeight: 500 }}>{status.name}</div>
        <div style={{ fontSize: "0.875rem" }}>
          {isConnected ? (
            <span style={{ color: "var(--green-11, #2b9348)" }}>✓ Connected</span>
          ) : (
            <span style={{ opacity: 0.75 }}>Not connected</span>
          )}
        </div>
      </div>
      {isConnected ? (
        <button
          type="button"
          onClick={onDisconnect}
          style={buttonStyle}
        >
          Disconnect
        </button>
      ) : (
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          style={{
            ...buttonStyle,
            opacity: connecting ? 0.6 : 1,
            cursor: connecting ? "wait" : "pointer",
          }}
        >
          {connecting ? "Waiting for browser…" : "Connect"}
        </button>
      )}
    </div>
  );
}

interface EnvProviderRowProps {
  status: ProviderStatus;
}

function EnvProviderRow({ status }: EnvProviderRowProps) {
  const isConfigured = status.status === "configured";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
        border: "1px solid var(--gray-a5, rgba(0,0,0,0.15))",
        borderRadius: "8px",
        padding: "1rem",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <div style={{ fontWeight: 500 }}>{status.name}</div>
        <div style={{ fontSize: "0.875rem", opacity: 0.75 }}>
          {status.envVar ?? "(no env var)"}:{" "}
          {isConfigured ? (
            <span style={{ color: "var(--green-11, #2b9348)" }}>✓ set</span>
          ) : (
            <span style={{ color: "var(--red-11, #c91432)" }}>✗ not set</span>
          )}
        </div>
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  borderRadius: "6px",
  border: "1px solid var(--gray-a6, rgba(0,0,0,0.2))",
  background: "var(--gray-a3, rgba(0,0,0,0.05))",
  cursor: "pointer",
  fontSize: "0.875rem",
  fontWeight: 500,
};

function ThemedApp() {
  const theme = usePanelTheme();
  return (
    <Theme appearance={theme} radius="medium">
      <ModelProviderConfigPage />
    </Theme>
  );
}

// Mount the app
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<ThemedApp />);
}
