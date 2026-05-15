declare module "firebase-admin/app" {
  export type App = object;
  export interface ServiceAccount {
    projectId?: string;
    clientEmail?: string;
    privateKey?: string;
  }

  export function cert(serviceAccount: ServiceAccount): unknown;
  export function initializeApp(
    options?: { credential?: unknown; projectId?: string },
    name?: string
  ): App;
  export function getApps(): App[];
  export function getApp(name?: string): App;
}

declare module "firebase-admin/messaging" {
  import type { App } from "firebase-admin/app";

  export interface Message {
    token?: string;
    topic?: string;
    condition?: string;
    data?: Record<string, string>;
    notification?: {
      title?: string;
      body?: string;
      imageUrl?: string;
    };
    android?: unknown;
    apns?: unknown;
  }

  export interface Messaging {
    send(message: Message): Promise<string>;
    sendEachForMulticast(message: Message & { tokens: string[] }): Promise<unknown>;
  }

  export function getMessaging(app?: App): Messaging;
}
