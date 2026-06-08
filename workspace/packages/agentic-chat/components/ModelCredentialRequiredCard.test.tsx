// @vitest-environment jsdom

import { Theme } from "@radix-ui/themes";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ModelCredentialRequiredCard from "./ModelCredentialRequiredCard";

describe("ModelCredentialRequiredCard", () => {
  it("switches the selected model before connecting credentials and persists best-effort", async () => {
    const calls: Array<{ participantId: string; method: string; args: unknown }> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chat = {
      callMethod: vi.fn(async (participantId: string, method: string, args: unknown) => {
        calls.push({ participantId, method, args });
        if (method === "persist_agent_model") throw new Error("approval denied");
        if (method === "credentialConnected") return { resumed: true };
        return { ok: true };
      }),
    };

    render(
      <Theme>
        <ModelCredentialRequiredCard
          chat={chat}
          props={{
            providerId: "openai-codex",
            modelRef: "openai-codex:gpt-5.5",
            modelBaseUrl: "https://chatgpt.com/backend-api",
            agentParticipantId: "do:agent",
            browserHandoffCallerId: "panel-1",
            browserHandoffCallerKind: "panel",
            resumeAfterConnect: true,
            providerOptions: [
              {
                providerId: "openai-codex",
                providerLabel: "ChatGPT",
                modelRef: "openai-codex:gpt-5.5",
                modelName: "GPT-5.5",
                modelBaseUrl: "https://chatgpt.com/backend-api",
                flow: { type: "oauth2-auth-code-pkce" },
              },
              {
                providerId: "anthropic",
                providerLabel: "Anthropic",
                modelRef: "anthropic:claude-3-5-sonnet-20241022",
                modelName: "Claude 3.5 Sonnet",
                modelBaseUrl: "https://api.anthropic.com",
                flow: { type: "api-key" },
              },
            ],
          }}
        />
      </Theme>
    );

    fireEvent.click(screen.getByText("Anthropic"));
    fireEvent.click(screen.getByRole("button", { name: /Enter API Key/i }));

    await waitFor(() => expect(chat.callMethod).toHaveBeenCalledTimes(4));
    expect(calls.map((call) => [call.participantId, call.method])).toEqual([
      ["do:agent", "setModel"],
      ["panel-1", "persist_agent_model"],
      ["do:agent", "connectModelCredential"],
      ["do:agent", "credentialConnected"],
    ]);
    expect(calls[1]?.args).toEqual({
      participantId: "do:agent",
      model: "anthropic:claude-3-5-sonnet-20241022",
    });
    expect(calls[2]?.args).toMatchObject({
      providerId: "anthropic",
      modelBaseUrl: "https://api.anthropic.com",
      modelRef: "anthropic:claude-3-5-sonnet-20241022",
      browserOpenMode: "internal",
    });
    await waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
