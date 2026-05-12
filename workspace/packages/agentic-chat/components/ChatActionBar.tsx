import { Suspense, useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Box, Spinner } from "@radix-ui/themes";
import { EventErrorBoundary } from "@workspace/tool-ui/components/EventErrorBoundary";
import { useChatContext } from "../context/ChatContext";
import { wrapChatForErrorReporting, wrapScopesForErrorReporting } from "../utils/wrapSandboxApis";
import { InlineUiErrorCallout } from "./InlineUiMessage";
import type { ActionBarState } from "../types";

const DEFAULT_MAX_HEIGHT = 160;
const MIN_MAX_HEIGHT = 64;
const MAX_MAX_HEIGHT = 240;

function clampMaxHeight(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_HEIGHT;
  return Math.min(MAX_MAX_HEIGHT, Math.max(MIN_MAX_HEIGHT, value));
}

function ChatActionBarContent({ actionBar }: { actionBar: ActionBarState }) {
  const { chat, scope, scopes, scopeManager } = useChatContext();
  const { data, component } = actionBar;
  const CompiledComponent = component?.Component;
  const componentProps = useMemo(() => data.props ?? {}, [data.props]);
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  const [asyncError, setAsyncError] = useState<Error | null>(null);

  const onAsyncError = useCallback((err: Error) => setAsyncError(err), []);
  const wrappedChat = useMemo(
    () => wrapChatForErrorReporting(chat, onAsyncError),
    [chat, onAsyncError],
  );
  const wrappedScopes = useMemo(
    () => wrapScopesForErrorReporting(scopes, onAsyncError),
    [scopes, onAsyncError],
  );

  useEffect(() => {
    if (!scopeManager) return;
    return scopeManager.onChange(forceUpdate);
  }, [scopeManager]);

  const onInteraction = useCallback(() => {
    void scopeManager?.persist().catch((err) => {
      console.warn("[ChatActionBar] Scope persist after interaction failed:", err);
    });
  }, [scopeManager]);

  const resetKey = `${data.id}:${JSON.stringify(data.props ?? {})}`;
  useEffect(() => { setAsyncError(null); }, [resetKey]);

  const maxHeight = clampMaxHeight(data.maxHeight);

  return (
    <Box
      className="chat-action-bar"
      data-action-bar-id={data.id}
      style={{ maxBlockSize: maxHeight }}
    >
      <Box
        className="chat-action-bar-content"
        onClickCapture={onInteraction}
        onInputCapture={onInteraction}
        onChangeCapture={onInteraction}
      >
        {asyncError ? (
          <InlineUiErrorCallout error={asyncError} componentId={data.id} chat={chat} />
        ) : component?.error ? (
          <InlineUiErrorCallout error={new Error(component.error)} componentId={data.id} chat={chat} />
        ) : !CompiledComponent ? (
          <Spinner size="1" />
        ) : (
          <EventErrorBoundary
            resetKey={resetKey}
            renderFallback={(error) => (
              <InlineUiErrorCallout error={error} componentId={data.id} chat={chat} />
            )}
          >
            <Suspense fallback={<Spinner size="1" />}>
              <CompiledComponent props={componentProps} chat={wrappedChat as unknown as Record<string, unknown>} scope={scope} scopes={wrappedScopes as unknown as Record<string, unknown>} />
            </Suspense>
          </EventErrorBoundary>
        )}
      </Box>
    </Box>
  );
}

export function ChatActionBar() {
  const { actionBar } = useChatContext();
  if (!actionBar) return null;
  return <ChatActionBarContent actionBar={actionBar} />;
}
