/**
 * SettingsClient -- Shared settings RPC wrapper.
 *
 * Wraps the settings.getData server RPC call. Provider/model mutation methods
 * (setApiKey, removeApiKey, setModelRole) were removed in the Phase 8
 * migration to the chat agent path.
 */
import type { RpcClient } from "@natstack/rpc";
import { settingsMethods } from "../serviceSchemas/settings.js";
import { createTypedServiceClient, type TypedServiceClient } from "../typedServiceClient.js";
import type { SettingsData } from "../types.js";
export class SettingsClient {
    private typed: TypedServiceClient<typeof settingsMethods>;
    constructor(rpc: Pick<RpcClient, "call">) {
        this.typed = createTypedServiceClient("settings", settingsMethods, (service, method, args) =>
            rpc.call("main", `${service}.${method}`, args)
        );
    }
    getData(): Promise<SettingsData> {
        return this.typed.getData();
    }
}
