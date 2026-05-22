export type AgentDataMode = "fixture" | "live";

let dataMode: AgentDataMode = "live";
const customStateProviders = new Map<string, () => unknown>();

declare global {
  interface Window {
    __natstackAgentMode?: AgentDataMode;
  }
}

function visibleText(): string {
  return (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

function describeElement(element: Element, depth = 0): unknown {
  const children = [...element.children].slice(0, 50).map((child) => describeElement(child, depth + 1));
  return {
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role") ?? undefined,
    label: element.getAttribute("aria-label") ?? undefined,
    text: children.length === 0 ? (element.textContent ?? "").trim().slice(0, 160) : undefined,
    children,
    depth,
  };
}

export const agentApi = {
  snapshot() {
    return {
      kind: "synth",
      text: visibleText(),
      structure: document.body ? describeElement(document.body) : null,
    };
  },
  tree() {
    return document.body ? describeElement(document.body) : null;
  },
  state() {
    return Object.fromEntries([...customStateProviders].map(([key, provider]) => [key, provider()]));
  },
  routes() {
    return {
      href: location.href,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    };
  },
  setMode(mode: AgentDataMode) {
    dataMode = mode;
    window.__natstackAgentMode = mode;
    window.dispatchEvent(new CustomEvent("natstack:agentModeChanged", { detail: mode }));
    return { mode };
  },
  getMode() {
    return dataMode;
  },
  registerStateProvider(key: string, provider: () => unknown) {
    customStateProviders.set(key, provider);
    return () => customStateProviders.delete(key);
  },
};

export function registerAgentApi(shell: any): void {
  if (!shell?.panel?.registerAgentHandler) return;
  shell.panel.registerAgentHandler("_agent.snapshot", () => agentApi.snapshot());
  shell.panel.registerAgentHandler("_agent.tree", () => agentApi.tree());
  shell.panel.registerAgentHandler("_agent.state", () => agentApi.state());
  shell.panel.registerAgentHandler("_agent.routes", () => agentApi.routes());
  shell.panel.registerAgentHandler("_agent.setMode", (mode: AgentDataMode) => agentApi.setMode(mode));
}
