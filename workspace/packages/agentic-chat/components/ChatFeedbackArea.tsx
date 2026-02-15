import { Flex } from "@radix-ui/themes";
import {
  FeedbackContainer,
  FeedbackFormRenderer,
} from "@workspace/tool-ui";
import { useChatContext } from "../context/ChatContext";

/**
 * Renders active feedback forms (schema-based and TSX-based).
 * Reads from ChatContext.
 */
export function ChatFeedbackArea() {
  const { activeFeedbacks, onFeedbackDismiss, onFeedbackError } = useChatContext();

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
          <FeedbackContainer
            key={feedback.callId}
            title={feedback.title}
            onDismiss={() => onFeedbackDismiss(feedback.callId)}
            onError={(error) => onFeedbackError(feedback.callId, error)}
          >
            <FeedbackComponent
              onSubmit={(value) => feedback.complete({ type: "submit", value })}
              onCancel={() => feedback.complete({ type: "cancel" })}
              onError={(message) => feedback.complete({ type: "error", message })}
            />
          </FeedbackContainer>
        );
      })}
    </Flex>
  );
}
