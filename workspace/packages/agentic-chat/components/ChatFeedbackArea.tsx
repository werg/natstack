import { useCallback, useMemo, type ComponentType } from "react";
import { Flex } from "@radix-ui/themes";
import {
  FeedbackContainer,
  FeedbackFormRenderer,
  type ActiveFeedbackTsx,
  type FeedbackComponentProps,
} from "@workspace/tool-ui";
import type { ChatSandboxValue } from "@workspace/agentic-core";
import type { ScopesApi, ScopeManager } from "@workspace/eval";
import { wrapChatForErrorReporting, wrapScopesForErrorReporting } from "../utils/wrapSandboxApis";
import { useChatContext } from "../context/ChatContext";

/**
 * Renders active feedback forms (schema-based and TSX-based).
 * Reads from ChatContext.
 */
export function ChatFeedbackArea() {
  const { activeFeedbacks, onFeedbackDismiss, onFeedbackError, chat, scope, scopes, scopeManager } = useChatContext();

  // DOM event delegation — silent best-effort persist after user interaction
  const onInteraction = useCallback(() => scopeManager?.schedulePersist(2000), [scopeManager]);

  if (activeFeedbacks.size === 0) return null;

  return (
    <Flex direction="column" gap="2" flexShrink="0">
      {Array.from(activeFeedbacks.values()).map((feedback) => {
        // Render schema-based feedbacks using FeedbackFormRenderer
        if (feedback.type === "schema") {
          return (
            <FeedbackContainer
              key={feedback.callId}
              onDismiss={() => onFeedbackDismiss(feedback.callId)}
              onError={(error) => onFeedbackError(feedback.callId, error)}
            >
              <FeedbackFormRenderer
                title={feedback.title}
                fields={feedback.fields}
                initialValues={feedback.values}
                submitLabel={feedback.submitLabel}
                cancelLabel={feedback.cancelLabel}
                timeout={feedback.timeout}
                timeoutAction={feedback.timeoutAction}
                severity={feedback.severity}
                hideSubmit={feedback.hideSubmit}
                hideCancel={feedback.hideCancel}
                onSubmit={(value) => feedback.complete({ type: "submit", value })}
                onCancel={() => feedback.complete({ type: "cancel" })}
                onError={(message) => feedback.complete({ type: "error", message })}
              />
            </FeedbackContainer>
          );
        }

        // Render TSX-based feedbacks (type === "tsx")
        const FeedbackComponent = feedback.Component;
        if (!FeedbackComponent || typeof FeedbackComponent !== "function") {
          onFeedbackError(feedback.callId, new Error("Invalid feedback component"));
          return null;
        }
        return (
          <TsxFeedbackItem
            key={feedback.callId}
            feedback={feedback}
            FeedbackComponent={FeedbackComponent}
            chat={chat}
            scope={scope}
            scopes={scopes}
            scopeManager={scopeManager}
            onDismiss={() => onFeedbackDismiss(feedback.callId)}
            onError={(error) => onFeedbackError(feedback.callId, error)}
            onInteraction={onInteraction}
          />
        );
      })}
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// TsxFeedbackItem — per-feedback wrapper that memoizes async-error wrappers
// ---------------------------------------------------------------------------

interface TsxFeedbackItemProps {
  feedback: ActiveFeedbackTsx;
  FeedbackComponent: ComponentType<FeedbackComponentProps>;
  chat: ChatSandboxValue;
  scope: Record<string, unknown>;
  scopes: ScopesApi;
  scopeManager: ScopeManager | null;
  onDismiss: () => void;
  onError: (error: Error) => void;
  onInteraction: () => void;
}

function TsxFeedbackItem({
  feedback, FeedbackComponent, chat, scope, scopes, scopeManager,
  onDismiss, onError, onInteraction,
}: TsxFeedbackItemProps) {
  // Wrap chat/scopes so unhandled async rejections route to onError.
  // Memoized per feedback — onError changes when callId changes (new feedback).
  const wrappedChat = useMemo(
    () => wrapChatForErrorReporting(chat, onError),
    [chat, onError],
  );
  const wrappedScopes = useMemo(
    () => wrapScopesForErrorReporting(scopes, onError),
    [scopes, onError],
  );

  return (
    <FeedbackContainer
      title={feedback.title}
      onDismiss={onDismiss}
      onError={onError}
    >
      <div onClickCapture={onInteraction} onInputCapture={onInteraction} onChangeCapture={onInteraction}>
        <FeedbackComponent
          onSubmit={(value) => {
            const done = () => feedback.complete({ type: "submit", value });
            scopeManager ? void scopeManager.persist().catch(() => {}).then(done) : done();
          }}
          onCancel={() => {
            const done = () => feedback.complete({ type: "cancel" });
            scopeManager ? void scopeManager.persist().catch(() => {}).then(done) : done();
          }}
          onError={(message) => feedback.complete({ type: "error", message })}
          chat={wrappedChat as unknown as Record<string, unknown>}
          scope={scope}
          scopes={wrappedScopes as unknown as Record<string, unknown>}
        />
      </div>
    </FeedbackContainer>
  );
}
