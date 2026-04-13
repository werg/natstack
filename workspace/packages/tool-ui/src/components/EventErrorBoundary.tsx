/**
 * EventErrorBoundary — catches both React render errors AND event-handler errors.
 *
 * React error boundaries (getDerivedStateFromError / componentDidCatch) only
 * catch errors thrown during rendering or in lifecycle methods.  Errors thrown
 * inside event handlers (onClick, onChange, …) bypass boundaries entirely and
 * surface as uncaught exceptions on `window`.
 *
 * This component closes that gap:
 *   1. Capture-phase listeners on the wrapper div set a module-level flag
 *      (`activeBoundary`) when a DOM event originates from our subtree.
 *   2. A `window "error"` listener checks the flag.  If set, the error is
 *      attributed to this boundary: we show an error state, call `onError`,
 *      and `preventDefault()` the ErrorEvent to suppress the console noise.
 *   3. A microtask resets the flag after the synchronous handler finishes,
 *      so unrelated errors that happen later are not mis-attributed.
 *
 * Limitations:
 *   - Only synchronous throws inside event handlers are caught.  Errors from
 *     `await`-ed promises inside handlers fire `unhandledrejection` after the
 *     microtask boundary, when the flag has already been cleared.  Components
 *     should use try/catch around awaits or call `onError` explicitly.
 *   - If two boundaries are nested and an event bubbles through both capture
 *     phases, the innermost one wins (it writes `activeBoundary` last).
 */

import { Component, type ReactNode, createRef } from "react";

// ---------------------------------------------------------------------------
// Module-level tracking — only one JS event handler runs at a time, so a
// single variable is sufficient.
// ---------------------------------------------------------------------------

let activeBoundary: EventErrorBoundary | null = null;

// Global listener, installed once.  Checks whether the current error belongs
// to a tracked boundary.
let globalListenerInstalled = false;
let boundaryCount = 0;

function installGlobalListener() {
  if (globalListenerInstalled) return;
  globalListenerInstalled = true;
  window.addEventListener("error", (event: ErrorEvent) => {
    const boundary = activeBoundary;
    if (!boundary) return;
    activeBoundary = null;
    event.preventDefault();
    const error =
      event.error instanceof Error
        ? event.error
        : new Error(event.message || "Unknown error in event handler");
    boundary.handleEventHandlerError(error);
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface EventErrorBoundaryProps {
  children: ReactNode;
  /** Called when any error is caught — render-time or event-handler. */
  onError?: (error: Error) => void;
  /** Changing this value clears the error state (useful for retry). */
  resetKey?: string;
  /** Custom fallback UI.  When omitted a default red box is shown. */
  renderFallback?: (error: Error) => ReactNode;
}

interface EventErrorBoundaryState {
  error: Error | null;
  prevResetKey?: string;
}

export class EventErrorBoundary extends Component<
  EventErrorBoundaryProps,
  EventErrorBoundaryState
> {
  state: EventErrorBoundaryState = { error: null };
  private containerRef = createRef<HTMLDivElement>();

  // ── React error boundary (render-time errors) ────────────────────────────

  static getDerivedStateFromError(error: Error): Partial<EventErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: EventErrorBoundaryProps,
    state: EventErrorBoundaryState,
  ): Partial<EventErrorBoundaryState> | null {
    if (props.resetKey !== state.prevResetKey) {
      return { error: null, prevResetKey: props.resetKey };
    }
    return { prevResetKey: props.resetKey };
  }

  componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }

  // ── Lifecycle — manage the global listener refcount ──────────────────────

  componentDidMount(): void {
    boundaryCount++;
    installGlobalListener();
  }

  componentWillUnmount(): void {
    boundaryCount--;
    if (activeBoundary === this) activeBoundary = null;
  }

  // ── Event-handler error path ─────────────────────────────────────────────

  /** Called by the global `window "error"` listener when an error is
   *  attributed to this boundary. */
  handleEventHandlerError(error: Error): void {
    this.setState({ error });
    this.props.onError?.(error);
  }

  /** Capture-phase handler — marks this boundary as the active target. */
  private trackEvent = (): void => {
    activeBoundary = this;
    queueMicrotask(() => {
      if (activeBoundary === this) activeBoundary = null;
    });
  };

  // ── Render ───────────────────────────────────────────────────────────────

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.renderFallback) {
        return this.props.renderFallback(this.state.error);
      }
      return (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 6,
            background: "var(--red-3, #fee)",
            border: "1px solid var(--red-6, #e5c5c5)",
            color: "var(--red-11, #c33)",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <strong>Component error</strong>
          <div style={{ marginTop: 4, fontFamily: "monospace", fontSize: 12 }}>
            {this.state.error.message}
          </div>
        </div>
      );
    }

    return (
      <div
        ref={this.containerRef}
        onClickCapture={this.trackEvent}
        onChangeCapture={this.trackEvent}
        onInputCapture={this.trackEvent}
        onSubmitCapture={this.trackEvent}
        onKeyDownCapture={this.trackEvent}
        onKeyUpCapture={this.trackEvent}
        onFocusCapture={this.trackEvent}
        onBlurCapture={this.trackEvent}
        onPointerDownCapture={this.trackEvent}
        onPointerUpCapture={this.trackEvent}
      >
        {this.props.children}
      </div>
    );
  }
}
