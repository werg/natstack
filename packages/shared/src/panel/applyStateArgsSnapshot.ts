export function applyStateArgsSnapshot(next: Record<string, unknown>): void {
  (window as { __natstackStateArgs?: Record<string, unknown> }).__natstackStateArgs = next;
  window.dispatchEvent(new CustomEvent("natstack:stateArgsChanged", { detail: next }));
}
