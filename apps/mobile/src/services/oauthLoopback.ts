import { Linking, NativeModules } from "react-native";
import type { ShellClient } from "./shellClient";
export interface OAuthLoopbackHandoff {
    transactionId: string;
    redirectUri: string;
    host: "localhost" | "127.0.0.1";
    port: number;
    callbackPath: string;
    state: string;
    timeoutMs: number;
}
export interface ExternalOpenPayload {
    url?: string;
    oauthLoopback?: OAuthLoopbackHandoff;
}
interface OAuthLoopbackNativeModule {
    start(options: {
        host: "localhost" | "127.0.0.1";
        port: number;
        callbackPath: string;
        expectedState: string;
        timeoutMs: number;
    }): Promise<void>;
    wait(): Promise<{
        url: string;
        code?: string;
        state: string;
        error?: string;
    }>;
    stop(): Promise<void>;
}
function getNativeModule(): OAuthLoopbackNativeModule {
    const nativeModule = NativeModules["OAuthLoopback"] as OAuthLoopbackNativeModule | undefined;
    if (!nativeModule) {
        throw new Error("Android OAuth loopback support is not available in this build");
    }
    return nativeModule;
}
export async function handleExternalOpen(shellClient: ShellClient, payload: ExternalOpenPayload): Promise<void> {
    if (!payload.url)
        return;
    if (!payload.oauthLoopback) {
        const oauthError = describeMissingLoopback(payload.url);
        if (oauthError) {
            throw new Error(oauthError);
        }
        await Linking.openURL(payload.url);
        return;
    }
    const native = getNativeModule();
    const loopback = payload.oauthLoopback;
    let callbackPending: Promise<{
        url: string;
        code?: string;
        state: string;
        error?: string;
    }> | null = null;
    try {
        await native.start({
            host: loopback.host,
            port: loopback.port,
            callbackPath: loopback.callbackPath,
            expectedState: loopback.state,
            timeoutMs: loopback.timeoutMs,
        });
        callbackPending = native.wait();
        await Linking.openURL(payload.url);
        const callback = await callbackPending;
        await shellClient.transport.call("main", "credentials.forwardOAuthCallback", [{
                transactionId: loopback.transactionId,
                url: callback.url,
                state: callback.state,
            }]);
    }
    catch (error) {
        await native.stop().catch(() => { });
        throw error;
    }
}
function describeMissingLoopback(rawUrl: string): string | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return null;
    }
    if (url.hostname !== "auth.openai.com" || !url.pathname.startsWith("/oauth/authorize")) {
        return null;
    }
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    if (redirectUri.startsWith("http://localhost:") || redirectUri.startsWith("http://127.0.0.1:")) {
        return null;
    }
    return "OpenAI OAuth was started without the Android loopback callback. Restart the NatStack server and retry so the mobile panel uses the client-loopback OAuth flow.";
}
