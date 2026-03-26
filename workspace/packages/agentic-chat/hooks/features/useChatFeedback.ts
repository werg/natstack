/**
 * useChatFeedback — Feedback form + custom feedback handlers.
 *
 * Manages feedback_form and feedback_custom method definitions,
 * feedback lifecycle, and dismiss/error handling.
 */

import { useCallback, useRef, useEffect } from "react";
import type {
  MethodDefinition,
  MethodExecutionContext,
  FeedbackFormArgs,
  FeedbackCustomArgs,
} from "@natstack/pubsub";
import {
  FeedbackFormArgsSchema,
  FeedbackCustomArgsSchema,
} from "@natstack/pubsub";
import {
  useFeedbackManager,
  type FeedbackResult,
  type ActiveFeedbackTsx,
  type ActiveFeedbackSchema,
  type ActiveFeedback,
} from "@workspace/tool-ui";
import { compileComponent } from "@workspace/eval";
import type { FeedbackComponentProps } from "@workspace/tool-ui";
import type { MethodHistoryEntry } from "../../components/MethodHistoryItem";
import type { ChatSandboxValue } from "../../types";

interface UseChatFeedbackOptions {
  addMethodHistoryEntry: (entry: MethodHistoryEntry) => void;
  updateMethodHistoryEntry: (callId: string, updates: Partial<MethodHistoryEntry>) => void;
  chat: ChatSandboxValue;
}

export interface ChatFeedbackState {
  activeFeedbacks: Map<string, ActiveFeedback>;
  /** Ref to current feedbacks — for stable access in callbacks */
  activeFeedbacksRef: React.MutableRefObject<Map<string, ActiveFeedback>>;
  /** Raw addFeedback/removeFeedback — needed by useChatTools for tool approval */
  addFeedback: ReturnType<typeof useFeedbackManager>["addFeedback"];
  removeFeedback: ReturnType<typeof useFeedbackManager>["removeFeedback"];
  /** Refs to feedback handlers — for use in connection effect */
  handleFeedbackFormCallRef: React.MutableRefObject<(callId: string, args: FeedbackFormArgs, ctx: MethodExecutionContext) => Promise<FeedbackResult>>;
  handleFeedbackCustomCallRef: React.MutableRefObject<(callId: string, args: FeedbackCustomArgs, ctx: MethodExecutionContext) => Promise<FeedbackResult>>;
  /** Build feedback method definitions for the connection */
  buildFeedbackMethods: () => Record<string, MethodDefinition>;
  onFeedbackDismiss: (callId: string) => void;
  onFeedbackError: (callId: string, error: Error) => void;
}

export function useChatFeedback({
  addMethodHistoryEntry,
  updateMethodHistoryEntry,
  chat,
}: UseChatFeedbackOptions): ChatFeedbackState {
  const { activeFeedbacks, addFeedback, removeFeedback, dismissFeedback, handleFeedbackError } = useFeedbackManager();
  const activeFeedbacksRef = useRef(activeFeedbacks);
  activeFeedbacksRef.current = activeFeedbacks;

  const handleFeedbackResult = useCallback((callId: string, feedbackResult: FeedbackResult) => {
    if (feedbackResult.type === "submit") {
      updateMethodHistoryEntry(callId, { status: "success", result: feedbackResult.value, completedAt: Date.now() });
    } else if (feedbackResult.type === "cancel") {
      updateMethodHistoryEntry(callId, { status: "success", result: null, completedAt: Date.now() });
    } else {
      updateMethodHistoryEntry(callId, { status: "error", error: feedbackResult.message, completedAt: Date.now() });
    }
  }, [updateMethodHistoryEntry]);

  const handleFeedbackFormCall = useCallback(
    async (callId: string, args: FeedbackFormArgs, ctx: MethodExecutionContext) => {
      const entry: MethodHistoryEntry = {
        callId, methodName: "feedback_form", description: "Display a form to collect user input",
        args, status: "pending", startedAt: Date.now(), callerId: ctx.callerId, handledLocally: true,
      };
      addMethodHistoryEntry(entry);
      return new Promise<FeedbackResult>((resolve) => {
        const feedback: ActiveFeedbackSchema = {
          type: "schema", callId, title: args.title, fields: args.fields, values: args.values ?? {},
          submitLabel: args.submitLabel, cancelLabel: args.cancelLabel,
          timeout: args.timeout, timeoutAction: args.timeoutAction, severity: args.severity,
          hideSubmit: args.hideSubmit, hideCancel: args.hideCancel, createdAt: Date.now(),
          complete: (feedbackResult: FeedbackResult) => {
            removeFeedback(callId); handleFeedbackResult(callId, feedbackResult); resolve(feedbackResult);
          },
        };
        addFeedback(feedback);
      });
    },
    [addFeedback, removeFeedback, addMethodHistoryEntry, handleFeedbackResult]
  );

  const handleFeedbackCustomCall = useCallback(
    async (callId: string, args: FeedbackCustomArgs, ctx: MethodExecutionContext) => {
      const entry: MethodHistoryEntry = {
        callId, methodName: "feedback_custom", description: "Display a custom React component for user interaction",
        args, status: "pending", startedAt: Date.now(), callerId: ctx.callerId, handledLocally: true,
      };
      addMethodHistoryEntry(entry);
      if (!args.code.includes("onSubmit")) {
        console.warn(
          "[feedback_custom] Component code does not reference 'onSubmit'. " +
          "The user will not be able to submit a response. Did you forget to destructure { onSubmit } from props?"
        );
      }
      const result = await compileComponent<import("react").ComponentType<FeedbackComponentProps>>(args.code);
      if (!result.success) {
        updateMethodHistoryEntry(callId, { status: "error", error: result.error, completedAt: Date.now() });
        throw new Error(result.error);
      }
      const cacheKey = result.cacheKey!;
      return new Promise<FeedbackResult>((resolve) => {
        let resolved = false;
        const feedback: ActiveFeedbackTsx = {
          type: "tsx", callId, Component: result.Component!, createdAt: Date.now(), cacheKey, title: args.title,
          complete: (feedbackResult: FeedbackResult) => {
            if (resolved) return; // Prevent double-submission
            resolved = true;
            removeFeedback(callId);
            handleFeedbackResult(callId, feedbackResult); resolve(feedbackResult);
          },
        };
        addFeedback(feedback);
      });
    },
    [addFeedback, removeFeedback, addMethodHistoryEntry, updateMethodHistoryEntry, handleFeedbackResult]
  );

  const onFeedbackDismiss = useCallback((callId: string) => { dismissFeedback(callId); }, [dismissFeedback]);

  // Stable refs for connection effect
  const handleFeedbackFormCallRef = useRef(handleFeedbackFormCall);
  const handleFeedbackCustomCallRef = useRef(handleFeedbackCustomCall);
  useEffect(() => {
    handleFeedbackFormCallRef.current = handleFeedbackFormCall;
    handleFeedbackCustomCallRef.current = handleFeedbackCustomCall;
  }, [handleFeedbackFormCall, handleFeedbackCustomCall]);

  const buildFeedbackMethods = useCallback((): Record<string, MethodDefinition> => {
    const feedbackFormMethodDef: MethodDefinition = {
      description: `Show a form to collect user input.

**Result:** \`{ type: "submit", value: { fieldKey: userValue, ... } }\` or \`{ type: "cancel" }\`

**Field types:** string, number, boolean, select (needs \`options\`), slider (\`min\`/\`max\`), segmented (\`options\`)
**Field props:** \`key\` (required), \`label\` (required), \`type\` (required), \`default\`, \`required\`, \`description\`
**Pre-populate:** Add \`values: { "key": "existing value" }\``,
      parameters: FeedbackFormArgsSchema,
      execute: async (args: unknown, ctx: MethodExecutionContext) => handleFeedbackFormCallRef.current(ctx.callId, args as FeedbackFormArgs, ctx),
    };

    const feedbackCustomMethodDef: MethodDefinition = {
      description: `Show a custom React component that blocks until user submits or cancels.

**The component receives { onSubmit, onCancel, onError, chat, scope, scopes }:**
- onSubmit(value) — return data to the agent and close the form
- onCancel() — signal cancellation to the agent
- onError(message) — signal error
- chat — chat API (publish messages, call runtime, etc.)
  - chat.publish(type, payload) — send a message to the conversation
  - chat.rpc.call(target, method, ...args) — call runtime services
- scope — REPL scope (shared read+write state that persists across eval calls)
- scopes — scope management API — call scopes.save() after modifying scope

**Side effects during interaction:**
- Component can call chat.publish() or chat.rpc.call() before submitting
- Example: a form that runs validation via chat.rpc before returning results

**Result:** \`{ type: "submit", value: ... }\` or \`{ type: "cancel" }\`

**Requirements:**
- Component MUST use \`export default\`
- Syntax: TSX (TypeScript + JSX)
- Do NOT wrap in a Card — rendered inside a container with header and scroll area.

**Available imports:** react, @radix-ui/themes, @radix-ui/react-icons

**Example:**
\`\`\`tsx
import { useState } from "react";
import { Button, Flex, Text, TextField } from "@radix-ui/themes";

export default function App({ onSubmit, onCancel }) {
  const [name, setName] = useState("");
  return (
    <Flex direction="column" gap="3" p="2">
      <Text size="2" weight="bold">What is your name?</Text>
      <TextField.Root value={name} onChange={e => setName(e.target.value)} />
      <Flex gap="2" justify="end">
        <Button variant="soft" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onSubmit({ name })}>Submit</Button>
      </Flex>
    </Flex>
  );
}
\`\`\``,
      parameters: FeedbackCustomArgsSchema,
      execute: async (args: unknown, ctx: MethodExecutionContext) => handleFeedbackCustomCallRef.current(ctx.callId, args as FeedbackCustomArgs, ctx),
    };

    return {
      feedback_form: feedbackFormMethodDef,
      feedback_custom: feedbackCustomMethodDef,
    };
  }, []);

  return {
    activeFeedbacks,
    activeFeedbacksRef,
    addFeedback,
    removeFeedback,
    handleFeedbackFormCallRef,
    handleFeedbackCustomCallRef,
    buildFeedbackMethods,
    onFeedbackDismiss,
    onFeedbackError: handleFeedbackError,
  };
}
