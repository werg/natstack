// Lightweight, workerd-native CDP client. Speaks raw Chrome DevTools Protocol
// over a WebSocket (via globalThis.WebSocket), so it runs in a Cloudflare
// Worker / Durable Object isolate AND in panels. Exposes a Playwright-shaped
// `Page`/`Locator` surface implemented entirely over the Runtime/DOM/Input/Page
// CDP domains — no Node deps, no vendored browser bundle.
//
// Deliberately out of scope (no CDP-only path in a connectionless isolate):
// file uploads (setInputFiles), multi-page/popup lifecycle, cross-origin
// frames, and full network request interception (route). Raw `CdpConnection`
// is always available for protocol-level work those cases would need.

type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string; data?: string };
};

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type CdpEvent = {
  method: string;
  params?: unknown;
};

export type LightweightConsoleEvent = {
  type: string;
  text: string;
  args: unknown[];
};

export type LightweightDomInspection = {
  selector: string;
  found: boolean;
  tagName?: string;
  id?: string;
  className?: string;
  text?: string;
  visible?: boolean;
  attributes?: Record<string, string>;
  boundingBox?: { x: number; y: number; width: number; height: number };
};

export type BoundingBox = { x: number; y: number; width: number; height: number };

/** How a locator finds its element(s). Chains resolve left-to-right. */
type LocatorStep =
  | { by: "css"; value: string }
  | { by: "role"; value: string; name?: string; exact?: boolean }
  | { by: "text"; value: string; exact?: boolean }
  | { by: "label"; value: string; exact?: boolean }
  | { by: "placeholder"; value: string; exact?: boolean }
  | { by: "testid"; value: string }
  | { by: "alt"; value: string; exact?: boolean }
  | { by: "title"; value: string; exact?: boolean }
  | { filter: { hasText?: string; hasTextExact?: boolean } }
  | { nth: number };

type LocatorDescriptor = { steps: LocatorStep[] };

type ByTextOptions = { exact?: boolean };
type ByRoleOptions = { name?: string; exact?: boolean };
type ActionOptions = { timeout?: number };
type WaitState = "attached" | "detached" | "visible" | "hidden";

type WebSocketCtor = new (url: string) => WebSocket;

function getWebSocketCtor(): WebSocketCtor {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!ctor) {
    throw new Error("WebSocket is not available in this worker runtime");
  }
  return ctor;
}

function once(
  ws: WebSocket,
  event: "open" | "message" | "error" | "close"
): Promise<Event | MessageEvent> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener(event, handle);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("close", handleClose);
    };
    const handle = (ev: Event | MessageEvent) => {
      cleanup();
      resolve(ev);
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`CDP WebSocket ${event} failed`));
    };
    const handleClose = () => {
      cleanup();
      reject(new Error(`CDP WebSocket closed before ${event}`));
    };
    ws.addEventListener(event, handle);
    if (event !== "error") ws.addEventListener("error", handleError);
    if (event !== "close") ws.addEventListener("close", handleClose);
  });
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (data && typeof (data as Blob).text === "function") {
    return (data as Blob).text();
  }
  return String(data);
}

function decodeBase64(data: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const bufferCtor = (globalThis as { Buffer?: { from(data: string, enc: string): Uint8Array } })
    .Buffer;
  if (bufferCtor) return bufferCtor.from(data, "base64");
  throw new Error("No base64 decoder is available in this runtime");
}

export class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();
  private eventListeners = new Map<string, Set<(params: unknown) => void>>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      void this.handleMessage((event as MessageEvent).data);
    });
    ws.addEventListener("error", () => {
      const error = new Error("CDP WebSocket error");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    ws.addEventListener("close", () => {
      const error = new Error("CDP WebSocket closed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  static async connect(wsEndpoint: string, authToken?: string): Promise<CdpConnection> {
    const WebSocketImpl = getWebSocketCtor();
    const ws = new WebSocketImpl(wsEndpoint);
    await once(ws, "open");
    if (authToken) {
      ws.send(JSON.stringify({ type: "natstack:cdp-auth", token: authToken }));
      const event = (await once(ws, "message")) as MessageEvent;
      const parsed = JSON.parse(await messageText(event.data)) as { type?: string };
      if (parsed.type !== "natstack:cdp-auth-ok") {
        throw new Error("CDP authentication failed");
      }
    }
    return new CdpConnection(ws);
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const message = params ? { id, method, params } : { id, method };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(message));
    });
  }

  close(): void {
    this.ws.close();
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    const listeners = this.eventListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(method);
    };
  }

  private async handleMessage(data: unknown): Promise<void> {
    let parsed: CdpResponse & CdpEvent;
    try {
      parsed = JSON.parse(await messageText(data)) as CdpResponse & CdpEvent;
    } catch (err) {
      // A malformed CDP frame must not abort the handler with an unhandled
      // rejection — that would silently stop all further dispatch. Drop the bad
      // frame and keep the connection processing.
      console.error("[cdp-client] failed to parse CDP frame:", err);
      return;
    }
    if (typeof parsed.id !== "number") {
      if (parsed.method) {
        for (const listener of this.eventListeners.get(parsed.method) ?? []) {
          listener(parsed.params);
        }
      }
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    if (parsed.error) {
      pending.reject(new Error(parsed.error.message ?? parsed.error.data ?? "CDP command failed"));
      return;
    }
    pending.resolve(parsed.result);
  }
}

// ---------------------------------------------------------------------------
// In-page runtime. A single self-contained program injected into the target
// page via Runtime.evaluate. It owns element resolution (CSS + getBy* engines),
// visibility/actionability checks, and all DOM-side actions/reads. Pointer
// actions (click/hover/...) only *probe* here for a stable hit point; the
// actual mouse/key events are dispatched client-side via CDP Input.
//
// Kept as one literal string (no ${} interpolation) so it is the single source
// of truth and is trivially serialisable. `__nsRun(payload)` is the entrypoint.
// ---------------------------------------------------------------------------
const INPAGE = String.raw`
function nsNorm(s){ return (s==null?"":String(s)).replace(/\s+/g," ").trim(); }
function nsDedupe(a){ return a.filter(function(e,i){ return a.indexOf(e)===i; }); }
function nsText(el){ return nsNorm((el && (el.innerText!=null?el.innerText:el.textContent)) || ""); }
function nsTextMatch(el, q, exact){ var t=nsText(el); var n=nsNorm(q); return exact ? t===n : t.indexOf(n)!==-1; }
function nsAttr(el, name){ return el && el.getAttribute ? el.getAttribute(name) : null; }
function nsRole(el){
  var r = nsAttr(el,"role"); if(r) return r.trim().toLowerCase().split(/\s+/)[0];
  var tag = el.tagName ? el.tagName.toLowerCase() : "";
  if(tag==="a") return el.hasAttribute("href") ? "link" : "";
  if(tag==="button") return "button";
  if(tag==="select") return el.multiple ? "listbox" : "combobox";
  if(tag==="textarea") return "textbox";
  if(/^h[1-6]$/.test(tag)) return "heading";
  if(tag==="img") return "img";
  if(tag==="nav") return "navigation";
  if(tag==="main") return "main";
  if(tag==="ul"||tag==="ol") return "list";
  if(tag==="li") return "listitem";
  if(tag==="table") return "table";
  if(tag==="form") return "form";
  if(tag==="input"){
    var ty=(nsAttr(el,"type")||"text").toLowerCase();
    var m={checkbox:"checkbox",radio:"radio",button:"button",submit:"button",reset:"button",image:"button",range:"slider",number:"spinbutton",search:"searchbox"};
    return m[ty]||"textbox";
  }
  return "";
}
function nsAccName(el){
  var al=nsAttr(el,"aria-label"); if(al) return nsNorm(al);
  var lb=nsAttr(el,"aria-labelledby");
  if(lb){ var parts=lb.split(/\s+/).map(function(id){ var e=document.getElementById(id); return e?nsText(e):""; }); var j=nsNorm(parts.join(" ")); if(j) return j; }
  if(el.tagName==="IMG"){ var alt=nsAttr(el,"alt"); if(alt) return nsNorm(alt); }
  if(el.labels && el.labels.length) return nsNorm(Array.prototype.map.call(el.labels,function(l){return nsText(l);}).join(" "));
  var t=nsText(el); if(t) return t;
  var ph=nsAttr(el,"placeholder"); if(ph) return nsNorm(ph);
  var ti=nsAttr(el,"title"); if(ti) return nsNorm(ti);
  return "";
}
function nsVisible(el){
  if(!el||!el.getBoundingClientRect) return false;
  var s=getComputedStyle(el); var r=el.getBoundingClientRect();
  return s.visibility!=="hidden" && s.display!=="none" && Number(s.opacity||"1")>0 && r.width>0 && r.height>0;
}
function nsEnabled(el){ return !el.disabled && nsAttr(el,"aria-disabled")!=="true"; }
function nsEditable(el){
  if(el.isContentEditable) return true;
  var tag=el.tagName ? el.tagName.toLowerCase() : "";
  if(tag!=="input" && tag!=="textarea" && tag!=="select") return false;
  return !el.disabled && !el.readOnly;
}
function nsStepFind(roots, step){
  var out=[];
  if(step.by==="css"){
    for(var i=0;i<roots.length;i++){ var found=(roots[i]===document?document:roots[i]).querySelectorAll(step.value); for(var j=0;j<found.length;j++) out.push(found[j]); }
    return nsDedupe(out);
  }
  var pred=function(e){
    switch(step.by){
      case "role": { if(nsRole(e)!==String(step.value).toLowerCase()) return false; if(step.name!=null){ var n=nsAccName(e); return step.exact?n===nsNorm(step.name):n.indexOf(nsNorm(step.name))!==-1; } return true; }
      case "text": return nsTextMatch(e, step.value, step.exact);
      case "label": { var tag=e.tagName?e.tagName.toLowerCase():""; var formish=(tag==="input"||tag==="textarea"||tag==="select"||tag==="button")||e.isContentEditable; if(!formish) return false; var n=nsAccName(e); return step.exact?n===nsNorm(step.value):n.indexOf(nsNorm(step.value))!==-1; }
      case "placeholder": { var ph=nsAttr(e,"placeholder"); if(ph==null) return false; var v=nsNorm(ph); return step.exact?v===nsNorm(step.value):v.indexOf(nsNorm(step.value))!==-1; }
      case "testid": return nsAttr(e,"data-testid")===step.value;
      case "alt": { var a=nsAttr(e,"alt"); if(a==null) return false; var v2=nsNorm(a); return step.exact?v2===nsNorm(step.value):v2.indexOf(nsNorm(step.value))!==-1; }
      case "title": { var ti=nsAttr(e,"title"); if(ti==null) return false; var v3=nsNorm(ti); return step.exact?v3===nsNorm(step.value):v3.indexOf(nsNorm(step.value))!==-1; }
      default: return false;
    }
  };
  for(var k=0;k<roots.length;k++){
    var scope=roots[k]===document?document:roots[k];
    var all=scope.querySelectorAll("*");
    for(var m=0;m<all.length;m++){ if(pred(all[m])) out.push(all[m]); }
  }
  return nsDedupe(out);
}
function nsLocate(descriptor){
  var cur=[document];
  var steps=descriptor.steps||[];
  for(var i=0;i<steps.length;i++){
    var step=steps[i];
    if(step.filter){ cur=cur.filter(function(e){ return e!==document && (step.filter.hasText==null || nsTextMatch(e, step.filter.hasText, step.filter.hasTextExact)); }); continue; }
    if(step.nth!=null){ var idx=step.nth<0?cur.length+step.nth:step.nth; cur=(idx>=0&&idx<cur.length)?[cur[idx]]:[]; continue; }
    cur=nsStepFind(cur, step);
  }
  return cur;
}
function nsFirst(descriptor){ var e=nsLocate(descriptor); return e.length?e[0]:null; }
function nsBox(el){ var r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; }
function nsSleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
async function nsWaitForState(descriptor, state, timeout){
  var deadline=Date.now()+timeout;
  for(;;){
    var el=nsFirst(descriptor);
    var ok;
    if(state==="detached") ok=!el;
    else if(state==="attached") ok=!!el;
    else if(state==="hidden") ok=!el||!nsVisible(el);
    else ok=!!el&&nsVisible(el);
    if(ok) return el;
    if(Date.now()>deadline) throw new Error("Timeout "+timeout+"ms waiting for element to be "+state);
    await nsSleep(50);
  }
}
async function nsActionable(descriptor, timeout){
  var deadline=Date.now()+timeout; var prev=null;
  for(;;){
    var el=nsFirst(descriptor);
    if(el && nsVisible(el) && nsEnabled(el)){
      try{ el.scrollIntoView({block:"center",inline:"center"}); }catch(e){}
      var b=nsBox(el);
      if(prev && Math.abs(prev.x-b.x)<1 && Math.abs(prev.y-b.y)<1 && prev.width===b.width && prev.height===b.height){
        return {ok:true, x:b.x+b.width/2, y:b.y+b.height/2, box:b};
      }
      prev=b;
    } else { prev=null; }
    if(Date.now()>deadline) return {ok:false, reason: el?(nsVisible(el)?"not enabled":"not visible"):"not found"};
    await nsSleep(30);
  }
}
async function __nsRun(P){
  var d=P.descriptor, a=P.arg, t=P.timeout;
  switch(P.op){
    case "probe": return await nsActionable(d, t);
    case "waitFor": { await nsWaitForState(d, P.state||"visible", t); return true; }
    case "count": return nsLocate(d).length;
    case "exists": return !!nsFirst(d);
    case "isVisible": { var e=nsFirst(d); return !!e && nsVisible(e); }
    case "isChecked": { var e=await nsWaitForState(d,"attached",t); return !!e.checked; }
    case "isEnabled": { var e=await nsWaitForState(d,"attached",t); return nsEnabled(e); }
    case "isDisabled": { var e=await nsWaitForState(d,"attached",t); return !nsEnabled(e); }
    case "isEditable": { var e=await nsWaitForState(d,"attached",t); return nsEditable(e); }
    case "textContent": { var e=nsFirst(d); return e?e.textContent:null; }
    case "innerText": { var e=await nsWaitForState(d,"visible",t); return e.innerText!=null?e.innerText:(e.textContent||""); }
    case "inputValue": { var e=await nsWaitForState(d,"attached",t); return "value" in e ? e.value : ""; }
    case "getAttribute": { var e=await nsWaitForState(d,"attached",t); return e.getAttribute(a.name); }
    case "boundingBox": { var e=nsFirst(d); return e?nsBox(e):null; }
    case "allTextContents": return nsLocate(d).map(function(e){ return e.textContent||""; });
    case "allInnerTexts": return nsLocate(d).map(function(e){ return e.innerText!=null?e.innerText:(e.textContent||""); });
    case "inspect": {
      var e=nsFirst(d);
      if(!e) return {found:false};
      var attrs={}; for(var i=0;i<e.attributes.length;i++){ attrs[e.attributes[i].name]=e.attributes[i].value; }
      return {found:true, tagName:e.tagName, id:e.id||"", className:typeof e.className==="string"?e.className:"", text:nsText(e).slice(0,4000), visible:nsVisible(e), attributes:attrs, boundingBox:nsBox(e)};
    }
    case "fill": { var e=await nsWaitForState(d,"visible",t); if(!("value" in e) && !e.isContentEditable) throw new Error("Element is not fillable"); e.focus&&e.focus(); if(e.isContentEditable){ e.textContent=a.value; } else { e.value=a.value; } e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); return true; }
    case "clear": { var e=await nsWaitForState(d,"visible",t); e.focus&&e.focus(); if(e.isContentEditable) e.textContent=""; else e.value=""; e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); return true; }
    case "setChecked": { var e=await nsWaitForState(d,"visible",t); if(e.checked!==a.checked){ e.checked=a.checked; e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); } return true; }
    case "selectOption": { var e=await nsWaitForState(d,"visible",t); var vals=a.values; var picked=[]; for(var i=0;i<e.options.length;i++){ var o=e.options[i]; var hit=vals.indexOf(o.value)!==-1||vals.indexOf(o.label)!==-1||vals.indexOf(nsNorm(o.textContent))!==-1; o.selected=hit; if(hit) picked.push(o.value); } e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); return picked; }
    case "focus": { var e=await nsWaitForState(d,"visible",t); e.focus&&e.focus(); return true; }
    case "blur": { var e=await nsWaitForState(d,"attached",t); e.blur&&e.blur(); return true; }
    case "scrollIntoView": { var e=await nsWaitForState(d,"attached",t); e.scrollIntoView({block:"center",inline:"center"}); return true; }
    case "selectText": { var e=await nsWaitForState(d,"visible",t); if(e.select) e.select(); else { var r=document.createRange(); r.selectNodeContents(e); var sel=getSelection(); sel.removeAllRanges(); sel.addRange(r); } return true; }
    case "dispatchEvent": { var e=await nsWaitForState(d,"attached",t); e.dispatchEvent(new Event(a.type,{bubbles:true})); return true; }
    case "focusForKey": { var e=await nsWaitForState(d,"visible",t); e.focus&&e.focus(); return true; }
    default: throw new Error("Unknown op: "+P.op);
  }
}
`;

const KEY_DEFS: Record<string, { keyCode?: number; key?: string; text?: string }> = {
  Enter: { keyCode: 13, key: "Enter", text: "\r" },
  Tab: { keyCode: 9, key: "Tab" },
  Escape: { keyCode: 27, key: "Escape" },
  Backspace: { keyCode: 8, key: "Backspace" },
  Delete: { keyCode: 46, key: "Delete" },
  ArrowUp: { keyCode: 38, key: "ArrowUp" },
  ArrowDown: { keyCode: 40, key: "ArrowDown" },
  ArrowLeft: { keyCode: 37, key: "ArrowLeft" },
  ArrowRight: { keyCode: 39, key: "ArrowRight" },
  Home: { keyCode: 36, key: "Home" },
  End: { keyCode: 35, key: "End" },
  PageUp: { keyCode: 33, key: "PageUp" },
  PageDown: { keyCode: 34, key: "PageDown" },
  Space: { keyCode: 32, key: " ", text: " " },
};

/**
 * Error thrown by locator actions/reads. `message` names the target locator
 * (Playwright-style) and the underlying reason; `.locator` holds the rendered
 * locator string and `.cause` the original error.
 */
export class CdpError extends Error {
  readonly locator?: string;
  constructor(message: string, options?: { cause?: unknown; locator?: string }) {
    super(message);
    this.name = "CdpError";
    this.locator = options?.locator;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Render a locator descriptor as a Playwright-style string for errors/toString(). */
function describeLocator(descriptor: LocatorDescriptor): string {
  const q = (s: string) => JSON.stringify(s);
  const parts = descriptor.steps.map((step) => {
    if ("filter" in step) {
      return `filter(${
        step.filter.hasText != null ? `{ hasText: ${q(step.filter.hasText)} }` : "{}"
      })`;
    }
    if ("nth" in step) {
      if (step.nth === 0) return "first()";
      if (step.nth === -1) return "last()";
      return `nth(${step.nth})`;
    }
    const exact = "exact" in step && step.exact ? ", { exact: true }" : "";
    switch (step.by) {
      case "css":
        return `locator(${q(step.value)})`;
      case "role": {
        const opts: string[] = [];
        if (step.name != null) opts.push(`name: ${q(step.name)}`);
        if (step.exact) opts.push("exact: true");
        return `getByRole(${q(step.value)}${opts.length ? `, { ${opts.join(", ")} }` : ""})`;
      }
      case "text":
        return `getByText(${q(step.value)}${exact})`;
      case "label":
        return `getByLabel(${q(step.value)}${exact})`;
      case "placeholder":
        return `getByPlaceholder(${q(step.value)}${exact})`;
      case "testid":
        return `getByTestId(${q(step.value)})`;
      case "alt":
        return `getByAltText(${q(step.value)}${exact})`;
      case "title":
        return `getByTitle(${q(step.value)}${exact})`;
    }
  });
  return parts.length ? parts.join(".") : "locator()";
}

class WorkerCdpPage {
  private currentUrl = "";
  private defaultTimeout = 30_000;
  private readonly consoleBuffer: LightweightConsoleEvent[] = [];

  constructor(readonly connection: CdpConnection) {
    this.connection.on("Runtime.consoleAPICalled", (params) => {
      const event = params as {
        type?: string;
        args?: Array<{ value?: unknown; description?: string; type?: string }>;
      };
      const args = (event.args ?? []).map((arg) =>
        Object.prototype.hasOwnProperty.call(arg, "value") ? arg.value : arg.description
      );
      this.consoleBuffer.push({
        type: event.type ?? "log",
        text: args.map((arg) => String(arg)).join(" "),
        args,
      });
    });
  }

  async initialize(): Promise<void> {
    await Promise.allSettled([
      this.connection.send("Page.enable"),
      this.connection.send("Runtime.enable"),
      this.connection.send("DOM.enable"),
    ]);
    this.currentUrl = String((await this.evaluate(() => location.href).catch(() => "")) ?? "");
  }

  // ---- Navigation -------------------------------------------------------
  async goto(url: string): Promise<unknown> {
    const result = (await this.connection.send("Page.navigate", { url })) as {
      frameId?: string;
      errorText?: string;
    };
    // Await the navigation settling (main frame stops loading / load event fires) before returning.
    // Without this, `goto` returns the instant Page.navigate is acknowledged, so a follow-up
    // screenshot/evaluate races the in-flight navigation — during a cross-origin swap the page is
    // momentarily detached and the command fails with "Not attached to an active page". Best-effort:
    // resolve on timeout rather than throw, so a slow page doesn't hard-fail the call.
    if (!result.errorText) {
      await this.waitForNavigationSettled(result.frameId, this.defaultTimeout);
    }
    this.currentUrl = url;
    return result;
  }

  /** Resolve once the page finishes (re)loading after a navigation, or after `timeout` ms. */
  private waitForNavigationSettled(frameId: string | undefined, timeout: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const cleanups: Array<() => void> = [];
      const finish = (): void => {
        for (const cleanup of cleanups.splice(0)) cleanup();
        resolve();
      };
      cleanups.push(this.connection.on("Page.loadEventFired", () => finish()));
      cleanups.push(
        this.connection.on("Page.frameStoppedLoading", (params) => {
          const fid = (params as { frameId?: string }).frameId;
          if (!frameId || fid === frameId) finish();
        })
      );
      const timer = setTimeout(finish, timeout);
      cleanups.push(() => clearTimeout(timer));
    });
  }

  async reload(): Promise<void> {
    await this.connection.send("Page.reload", {});
  }

  async goBack(): Promise<void> {
    await this.navigateHistory(-1);
  }

  async goForward(): Promise<void> {
    await this.navigateHistory(1);
  }

  private async navigateHistory(delta: number): Promise<void> {
    const history = (await this.connection.send("Page.getNavigationHistory", {})) as {
      currentIndex: number;
      entries: Array<{ id: number }>;
    };
    const target = history.entries[history.currentIndex + delta];
    if (!target) return;
    await this.connection.send("Page.navigateToHistoryEntry", { entryId: target.id });
  }

  async title(): Promise<string> {
    return String((await this.evaluate(() => document.title)) ?? "");
  }

  url(): string {
    return this.currentUrl;
  }

  async content(): Promise<string> {
    return String((await this.evaluate(() => document.documentElement?.outerHTML ?? "")) ?? "");
  }

  /** Set the default timeout (ms) used by auto-waiting actions/reads. Default 30000. */
  setDefaultTimeout(timeoutMs: number): void {
    this.defaultTimeout = timeoutMs;
  }

  // ---- Evaluate ---------------------------------------------------------
  async evaluate(
    pageFunction: string | ((arg?: unknown) => unknown),
    arg?: unknown
  ): Promise<unknown> {
    const expression =
      typeof pageFunction === "function"
        ? `(${pageFunction.toString()})(${JSON.stringify(arg)})`
        : pageFunction;
    const result = (await this.connection.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Evaluation failed");
    }
    return result.result?.value;
  }

  /** Run an in-page op against a locator descriptor; failures name the locator. */
  async runLocatorOp(
    op: string,
    descriptor: LocatorDescriptor,
    arg: unknown,
    opts: { timeout?: number; state?: WaitState } = {}
  ): Promise<unknown> {
    const payload = {
      op,
      descriptor,
      arg: arg ?? null,
      timeout: opts.timeout ?? this.defaultTimeout,
      state: opts.state ?? null,
    };
    const expr = `(async function(P){ ${INPAGE}\n return await __nsRun(P); })(${JSON.stringify(
      payload
    )})`;
    try {
      return await this.evaluate(expr);
    } catch (err) {
      const where = describeLocator(descriptor);
      const detail = err instanceof Error ? err.message : String(err);
      throw new CdpError(`${op} failed on ${where}: ${detail}`, { cause: err, locator: where });
    }
  }

  // ---- Locators ---------------------------------------------------------
  locator(selector: string): WorkerCdpLocator {
    return new WorkerCdpLocator(this, { steps: [{ by: "css", value: selector }] });
  }
  getByRole(role: string, options: ByRoleOptions = {}): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [{ by: "role", value: role, name: options.name, exact: options.exact }],
    });
  }
  getByText(text: string, options: ByTextOptions = {}): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [{ by: "text", value: text, exact: options.exact }],
    });
  }
  getByLabel(text: string, options: ByTextOptions = {}): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [{ by: "label", value: text, exact: options.exact }],
    });
  }
  getByPlaceholder(text: string, options: ByTextOptions = {}): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [{ by: "placeholder", value: text, exact: options.exact }],
    });
  }
  getByTestId(testId: string): WorkerCdpLocator {
    return new WorkerCdpLocator(this, { steps: [{ by: "testid", value: testId }] });
  }
  getByAltText(text: string, options: ByTextOptions = {}): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [{ by: "alt", value: text, exact: options.exact }],
    });
  }
  getByTitle(text: string, options: ByTextOptions = {}): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [{ by: "title", value: text, exact: options.exact }],
    });
  }

  // ---- Waits ------------------------------------------------------------
  async waitForTimeout(timeout: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, timeout));
  }

  async waitForFunction(
    pageFunction: string | ((arg?: unknown) => unknown),
    arg?: unknown,
    options?: { timeout?: number; polling?: number | "raf" }
  ): Promise<unknown> {
    let actualArg = arg;
    let actualOptions = options ?? {};
    if (
      options === undefined &&
      arg &&
      typeof arg === "object" &&
      ("timeout" in arg || "polling" in arg)
    ) {
      actualArg = undefined;
      actualOptions = arg as { timeout?: number; polling?: number | "raf" };
    }
    const timeout = actualOptions.timeout ?? this.defaultTimeout;
    const polling =
      typeof actualOptions.polling === "number" && actualOptions.polling > 0
        ? actualOptions.polling
        : 50;
    const source =
      typeof pageFunction === "function" ? `(${pageFunction.toString()})` : pageFunction;
    const isFunction = typeof pageFunction === "function";

    return this.evaluate(
      `(async function(source, isFunction, arg, timeout, polling) {
        const deadline = Date.now() + timeout;
        const predicateOrValue = isFunction
          ? (0, eval)(source)
          : new Function("arg", "return (" + source + ")");
        while (Date.now() <= deadline) {
          let value = await (
            typeof predicateOrValue === "function" ? predicateOrValue(arg) : predicateOrValue
          );
          if (typeof value === "function") value = await value(arg);
          if (value) return value === true ? true : value;
          await new Promise(resolve => setTimeout(resolve, polling));
        }
        throw new Error("Timeout " + timeout + "ms exceeded waiting for function");
      })(${JSON.stringify(source)}, ${JSON.stringify(isFunction)}, ${JSON.stringify(
        actualArg
      )}, ${JSON.stringify(timeout)}, ${JSON.stringify(polling)})`
    );
  }

  async waitForLoadState(
    state: "load" | "domcontentloaded" | "networkidle" = "load",
    options: { timeout?: number } = {}
  ): Promise<void> {
    const timeout = options.timeout ?? this.defaultTimeout;
    await this.evaluate(
      `(async function(state, timeout) {
        const deadline = Date.now() + timeout;
        function reached() {
          const ready = document.readyState;
          if (state === "domcontentloaded") return ready === "interactive" || ready === "complete";
          return ready === "complete";
        }
        while (Date.now() <= deadline) {
          if (reached()) return true;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("Timeout " + timeout + "ms exceeded waiting for load state " + state);
      })(${JSON.stringify(state)}, ${JSON.stringify(timeout)})`
    );
  }

  async waitForSelector(
    selector: string,
    options: { state?: WaitState; timeout?: number } = {}
  ): Promise<WorkerCdpElementHandle | null> {
    const loc = this.locator(selector);
    await loc.waitFor(options);
    if (options.state === "detached" || options.state === "hidden") return null;
    return new WorkerCdpElementHandle(this, { steps: [{ by: "css", value: selector }] });
  }

  // ---- Pointer / keyboard primitives (CDP Input) ------------------------
  /** Resolve a stable, actionable hit point for a descriptor (auto-waits). */
  async resolveHitPoint(
    descriptor: LocatorDescriptor,
    timeout: number = this.defaultTimeout
  ): Promise<{ x: number; y: number }> {
    const probe = (await this.runLocatorOp("probe", descriptor, null, { timeout })) as {
      ok: boolean;
      x?: number;
      y?: number;
      reason?: string;
    };
    if (!probe.ok || typeof probe.x !== "number" || typeof probe.y !== "number") {
      const where = describeLocator(descriptor);
      throw new CdpError(
        `not actionable (${probe.reason ?? "timeout"}) after ${timeout}ms: ${where}`,
        { locator: where }
      );
    }
    return { x: probe.x, y: probe.y };
  }

  async clickDescriptor(
    descriptor: LocatorDescriptor,
    opts: { clickCount?: number; button?: "left" | "right" | "middle"; timeout?: number } = {}
  ): Promise<void> {
    const { x, y } = await this.resolveHitPoint(descriptor, opts.timeout);
    const button = opts.button ?? "left";
    const clickCount = opts.clickCount ?? 1;
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount,
    });
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount,
    });
  }

  async hoverDescriptor(descriptor: LocatorDescriptor, opts: ActionOptions = {}): Promise<void> {
    const { x, y } = await this.resolveHitPoint(descriptor, opts.timeout);
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
  }

  async pressDescriptor(
    descriptor: LocatorDescriptor,
    key: string,
    opts: ActionOptions = {}
  ): Promise<void> {
    await this.runLocatorOp("focusForKey", descriptor, null, { timeout: opts.timeout });
    await this.pressKey(key);
  }

  /** Dispatch a key by name (e.g. "Enter") or single character. */
  async pressKey(key: string): Promise<void> {
    const def = KEY_DEFS[key];
    const base: Record<string, unknown> = def
      ? {
          key: def.key ?? key,
          windowsVirtualKeyCode: def.keyCode,
          nativeVirtualKeyCode: def.keyCode,
        }
      : { key, text: key.length === 1 ? key : undefined };
    await this.connection.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    const text = def?.text ?? (key.length === 1 ? key : undefined);
    if (text) {
      await this.connection.send("Input.dispatchKeyEvent", {
        type: "char",
        text,
        key: base["key"],
      });
    }
    await this.connection.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  // ---- Back-compat string-selector convenience methods ------------------
  async click(selector: string, opts: ActionOptions = {}): Promise<void> {
    await this.locator(selector).click(opts);
  }
  async fill(selector: string, value: string, opts: ActionOptions = {}): Promise<void> {
    await this.locator(selector).fill(value, opts);
  }
  async type(selector: string, text: string, opts: ActionOptions = {}): Promise<void> {
    await this.locator(selector).type(text, opts);
  }
  async isVisible(selector: string): Promise<boolean> {
    return this.locator(selector).isVisible();
  }
  async inspect(selector: string): Promise<LightweightDomInspection> {
    return this.locator(selector).inspect();
  }
  async textContent(selector: string): Promise<string | null> {
    return this.locator(selector).textContent();
  }
  async innerText(selector: string): Promise<string> {
    return this.locator(selector).innerText();
  }
  async querySelector(selector: string): Promise<WorkerCdpElementHandle | null> {
    const exists = await this.runLocatorOp(
      "exists",
      { steps: [{ by: "css", value: selector }] },
      null
    );
    return exists
      ? new WorkerCdpElementHandle(this, { steps: [{ by: "css", value: selector }] })
      : null;
  }

  // ---- Console ----------------------------------------------------------
  consoleEvents(): LightweightConsoleEvent[] {
    return [...this.consoleBuffer];
  }
  clearConsoleEvents(): void {
    this.consoleBuffer.length = 0;
  }

  // ---- Screenshot -------------------------------------------------------
  async screenshot(options: { type?: "png" | "jpeg"; quality?: number } = {}): Promise<Uint8Array> {
    const result = (await this.connection.send("Page.captureScreenshot", options)) as {
      data?: string;
    };
    if (!result.data) throw new Error("CDP screenshot did not return image data");
    return decodeBase64(result.data);
  }
}

class WorkerCdpLocator {
  constructor(
    protected readonly page: WorkerCdpPage,
    protected readonly descriptor: LocatorDescriptor
  ) {}

  private extend(step: LocatorStep): WorkerCdpLocator {
    return new WorkerCdpLocator(this.page, { steps: [...this.descriptor.steps, step] });
  }

  /** Playwright-style description, e.g. `getByRole("button", { name: "Go" })`. */
  toString(): string {
    return describeLocator(this.descriptor);
  }

  // ---- Scoped sub-locators / chaining -----------------------------------
  locator(selector: string): WorkerCdpLocator {
    return this.extend({ by: "css", value: selector });
  }
  getByRole(role: string, options: ByRoleOptions = {}): WorkerCdpLocator {
    return this.extend({ by: "role", value: role, name: options.name, exact: options.exact });
  }
  getByText(text: string, options: ByTextOptions = {}): WorkerCdpLocator {
    return this.extend({ by: "text", value: text, exact: options.exact });
  }
  getByLabel(text: string, options: ByTextOptions = {}): WorkerCdpLocator {
    return this.extend({ by: "label", value: text, exact: options.exact });
  }
  getByPlaceholder(text: string, options: ByTextOptions = {}): WorkerCdpLocator {
    return this.extend({ by: "placeholder", value: text, exact: options.exact });
  }
  getByTestId(testId: string): WorkerCdpLocator {
    return this.extend({ by: "testid", value: testId });
  }
  getByAltText(text: string, options: ByTextOptions = {}): WorkerCdpLocator {
    return this.extend({ by: "alt", value: text, exact: options.exact });
  }
  getByTitle(text: string, options: ByTextOptions = {}): WorkerCdpLocator {
    return this.extend({ by: "title", value: text, exact: options.exact });
  }
  filter(options: { hasText?: string; hasTextExact?: boolean } = {}): WorkerCdpLocator {
    return this.extend({
      filter: { hasText: options.hasText, hasTextExact: options.hasTextExact },
    });
  }
  nth(index: number): WorkerCdpLocator {
    return this.extend({ nth: index });
  }
  first(): WorkerCdpLocator {
    return this.nth(0);
  }
  last(): WorkerCdpLocator {
    return this.nth(-1);
  }
  async all(): Promise<WorkerCdpLocator[]> {
    const count = await this.count();
    const out: WorkerCdpLocator[] = [];
    for (let i = 0; i < count; i++) out.push(this.nth(i));
    return out;
  }

  // ---- Actions (auto-waiting) -------------------------------------------
  async click(opts: ActionOptions = {}): Promise<void> {
    await this.page.clickDescriptor(this.descriptor, opts);
  }
  async dblclick(opts: ActionOptions = {}): Promise<void> {
    await this.page.clickDescriptor(this.descriptor, { ...opts, clickCount: 2 });
  }
  async hover(opts: ActionOptions = {}): Promise<void> {
    await this.page.hoverDescriptor(this.descriptor, opts);
  }
  async fill(value: string, opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("fill", this.descriptor, { value }, opts);
  }
  async type(text: string, opts: ActionOptions = {}): Promise<void> {
    const current = (await this.page.runLocatorOp(
      "inputValue",
      this.descriptor,
      null,
      opts
    )) as string;
    await this.page.runLocatorOp(
      "fill",
      this.descriptor,
      { value: `${current ?? ""}${text}` },
      opts
    );
  }
  async clear(opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("clear", this.descriptor, null, opts);
  }
  async press(key: string, opts: ActionOptions = {}): Promise<void> {
    await this.page.pressDescriptor(this.descriptor, key, opts);
  }
  async check(opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("setChecked", this.descriptor, { checked: true }, opts);
  }
  async uncheck(opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("setChecked", this.descriptor, { checked: false }, opts);
  }
  async setChecked(checked: boolean, opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("setChecked", this.descriptor, { checked }, opts);
  }
  async selectOption(value: string | string[], opts: ActionOptions = {}): Promise<string[]> {
    const values = Array.isArray(value) ? value : [value];
    return (await this.page.runLocatorOp(
      "selectOption",
      this.descriptor,
      { values },
      opts
    )) as string[];
  }
  async focus(opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("focus", this.descriptor, null, opts);
  }
  async blur(opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("blur", this.descriptor, null, opts);
  }
  async selectText(opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("selectText", this.descriptor, null, opts);
  }
  async scrollIntoViewIfNeeded(opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("scrollIntoView", this.descriptor, null, opts);
  }
  async dispatchEvent(type: string, opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("dispatchEvent", this.descriptor, { type }, opts);
  }

  // ---- State / reads ----------------------------------------------------
  async waitFor(options: { state?: WaitState; timeout?: number } = {}): Promise<void> {
    await this.page.runLocatorOp("waitFor", this.descriptor, null, {
      state: options.state ?? "visible",
      timeout: options.timeout,
    });
  }
  async count(): Promise<number> {
    return Number((await this.page.runLocatorOp("count", this.descriptor, null)) ?? 0);
  }
  async isVisible(): Promise<boolean> {
    return Boolean(await this.page.runLocatorOp("isVisible", this.descriptor, null));
  }
  async isChecked(opts: ActionOptions = {}): Promise<boolean> {
    return Boolean(await this.page.runLocatorOp("isChecked", this.descriptor, null, opts));
  }
  async isEnabled(opts: ActionOptions = {}): Promise<boolean> {
    return Boolean(await this.page.runLocatorOp("isEnabled", this.descriptor, null, opts));
  }
  async isDisabled(opts: ActionOptions = {}): Promise<boolean> {
    return Boolean(await this.page.runLocatorOp("isDisabled", this.descriptor, null, opts));
  }
  async isEditable(opts: ActionOptions = {}): Promise<boolean> {
    return Boolean(await this.page.runLocatorOp("isEditable", this.descriptor, null, opts));
  }
  async getAttribute(name: string, opts: ActionOptions = {}): Promise<string | null> {
    const v = await this.page.runLocatorOp("getAttribute", this.descriptor, { name }, opts);
    return v == null ? null : String(v);
  }
  async inputValue(opts: ActionOptions = {}): Promise<string> {
    return String((await this.page.runLocatorOp("inputValue", this.descriptor, null, opts)) ?? "");
  }
  async innerText(opts: ActionOptions = {}): Promise<string> {
    return String((await this.page.runLocatorOp("innerText", this.descriptor, null, opts)) ?? "");
  }
  async textContent(): Promise<string | null> {
    const v = await this.page.runLocatorOp("textContent", this.descriptor, null);
    return v == null ? null : String(v);
  }
  async allInnerTexts(): Promise<string[]> {
    return (await this.page.runLocatorOp("allInnerTexts", this.descriptor, null)) as string[];
  }
  async allTextContents(): Promise<string[]> {
    return (await this.page.runLocatorOp("allTextContents", this.descriptor, null)) as string[];
  }
  async boundingBox(): Promise<BoundingBox | null> {
    return (await this.page.runLocatorOp(
      "boundingBox",
      this.descriptor,
      null
    )) as BoundingBox | null;
  }
  async inspect(): Promise<LightweightDomInspection> {
    const raw = (await this.page.runLocatorOp("inspect", this.descriptor, null)) as
      | (Omit<LightweightDomInspection, "selector"> & { found: boolean })
      | { found: false };
    const selector = JSON.stringify(this.descriptor.steps);
    if (!raw.found) return { selector, found: false };
    return { selector, ...(raw as object) } as LightweightDomInspection;
  }
}

class WorkerCdpElementHandle extends WorkerCdpLocator {}

class WorkerBrowser {
  constructor(
    private readonly page: WorkerCdpPage,
    private readonly connection: CdpConnection
  ) {}

  contexts(): Array<{ pages(): WorkerCdpPage[] }> {
    return [{ pages: () => [this.page] }];
  }

  async close(): Promise<void> {
    this.connection.close();
  }
}

export const BrowserImpl = {
  async connect(
    wsEndpoint: string,
    options: { transportOptions?: { authToken?: string } } = {}
  ): Promise<WorkerBrowser> {
    const connection = await CdpConnection.connect(wsEndpoint, options.transportOptions?.authToken);
    const page = new WorkerCdpPage(connection);
    await page.initialize();
    return new WorkerBrowser(page, connection);
  },
};

export type { WorkerCdpPage, WorkerCdpLocator, WorkerCdpElementHandle, WorkerBrowser };
