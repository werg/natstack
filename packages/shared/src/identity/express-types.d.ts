import type { CallerKind } from "./callerAssertion.js";

export interface NatstackCaller {
  callerId: string;
  callerKind: CallerKind;
}

declare module "http" {
  interface IncomingMessage {
    natstackCaller?: NatstackCaller;
  }
}

declare module "node:http" {
  interface IncomingMessage {
    natstackCaller?: NatstackCaller;
  }
}
