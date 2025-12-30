/**
 * Hook for managing feedback UI components and their lifecycle.
 * Handles state management for active feedback components with add/remove/dismiss/error operations.
 */

import { useReducer, useEffect, useCallback } from "react";
import type { ActiveFeedback } from "../components/ChatPhase";

/**
 * Feedback reducer manages active feedback UI components and their lifecycle.
 * Handles add, remove, and cleanup-on-unmount actions idomatically.
 */
function feedbackReducer(
  state: Map<string, ActiveFeedback>,
  action:
    | { type: "add"; payload: ActiveFeedback }
    | { type: "remove"; payload: string }
    | { type: "dismiss"; payload: string }
    | { type: "error"; payload: { callId: string; error: Error } }
    | { type: "cleanup-all" }
): Map<string, ActiveFeedback> {
  switch (action.type) {
    case "add": {
      const next = new Map(state);
      next.set(action.payload.callId, action.payload);
      return next;
    }
    case "remove": {
      const next = new Map(state);
      next.delete(action.payload);
      return next;
    }
    case "dismiss": {
      const feedback = state.get(action.payload);
      if (feedback) {
        // User dismissed = cancel (not an error)
        feedback.complete({ type: "cancel" });
      }
      const next = new Map(state);
      next.delete(action.payload);
      return next;
    }
    case "error": {
      const feedback = state.get(action.payload.callId);
      if (feedback) {
        // Component render error
        feedback.complete({ type: "error", message: `Component render error: ${action.payload.error.message}` });
      }
      const next = new Map(state);
      next.delete(action.payload.callId);
      return next;
    }
    case "cleanup-all": {
      // Cleanup all remaining feedbacks on unmount
      for (const feedback of state.values()) {
        feedback.complete({ type: "error", message: "Panel closed" });
      }
      return new Map();
    }
    default:
      return state;
  }
}

/**
 * Hook for managing feedback UI components.
 * Provides methods to add, remove, dismiss, and handle errors for feedback components.
 */
export function useFeedbackManager() {
  const [activeFeedbacks, dispatch] = useReducer(feedbackReducer, new Map());

  // Cleanup feedback components on unmount
  useEffect(() => {
    return () => {
      dispatch({ type: "cleanup-all" });
    };
  }, []);

  const addFeedback = useCallback((feedback: ActiveFeedback) => {
    dispatch({ type: "add", payload: feedback });
  }, []);

  const removeFeedback = useCallback((callId: string) => {
    dispatch({ type: "remove", payload: callId });
  }, []);

  const dismissFeedback = useCallback((callId: string) => {
    dispatch({ type: "dismiss", payload: callId });
  }, []);

  const handleFeedbackError = useCallback((callId: string, error: Error) => {
    dispatch({ type: "error", payload: { callId, error } });
  }, []);

  return {
    activeFeedbacks,
    addFeedback,
    removeFeedback,
    dismissFeedback,
    handleFeedbackError,
  };
}
