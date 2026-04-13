/**
 * wrapSandboxApis — wrap chat & scopes APIs for async error reporting.
 *
 * Each async method is wrapped via `trackPromise` so that if the compiled
 * component awaits the call without try/catch, the unhandled rejection is
 * caught and routed to `onError` (which typically completes the feedback or
 * shows a visual error).
 *
 * If the component handles the rejection itself, nothing extra happens.
 */

import { trackPromise } from "@workspace/tool-ui";
import type { ChatSandboxValue } from "@workspace/agentic-core";
import type { ScopesApi } from "@workspace/eval";

/**
 * Return a ChatSandboxValue where every async method is tracked.
 */
export function wrapChatForErrorReporting(
  chat: ChatSandboxValue,
  onError: (err: Error) => void,
): ChatSandboxValue {
  return {
    ...chat,
    publish: (...args: Parameters<ChatSandboxValue["publish"]>) =>
      trackPromise(chat.publish(...args), onError),
    callMethod: (...args: Parameters<ChatSandboxValue["callMethod"]>) =>
      trackPromise(chat.callMethod(...args), onError),
    rpc: {
      call: (...args: Parameters<ChatSandboxValue["rpc"]["call"]>) =>
        trackPromise(chat.rpc.call(...args), onError),
    },
  };
}

/**
 * Return a ScopesApi where every async method is tracked.
 */
export function wrapScopesForErrorReporting(
  scopes: ScopesApi,
  onError: (err: Error) => void,
): ScopesApi {
  return {
    get currentId() { return scopes.currentId; },
    push: (...args: Parameters<ScopesApi["push"]>) =>
      trackPromise(scopes.push(...args), onError),
    get: (...args: Parameters<ScopesApi["get"]>) =>
      trackPromise(scopes.get(...args), onError),
    list: (...args: Parameters<ScopesApi["list"]>) =>
      trackPromise(scopes.list(...args), onError),
    save: (...args: Parameters<ScopesApi["save"]>) =>
      trackPromise(scopes.save(...args), onError),
  };
}
