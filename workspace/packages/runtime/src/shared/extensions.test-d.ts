import type { ExtensionsClientRpc } from "@natstack/extension";
import type { Api as ImageServiceApi } from "@workspace-extensions/image-service";
import type { Api as ShellApi } from "@workspace-extensions/shell";
import { createExtensionsClient } from "./extensions.js";

// Type-level guarantees for the no-fallback extensions client. This file has no
// runtime tests; it exists purely so `tsc -p tsconfig.workspace.json` enforces
// that `use(name)` is keyed on the WorkspaceExtensions registry.

declare const rpc: ExtensionsClientRpc;
const extensions = createExtensionsClient(rpc);

// A registered name resolves to that extension's `activate` return type.
const imageService: ImageServiceApi = extensions.use("@workspace-extensions/image-service");
const shell: ShellApi = extensions.use("@workspace-extensions/shell");
void imageService;
void shell;

// An unregistered name is a compile error — there is no `string` escape hatch.
// @ts-expect-error "@workspace-extensions/not-a-real-extension" is not in WorkspaceExtensions
extensions.use("@workspace-extensions/not-a-real-extension");

// A bare string is likewise rejected.
declare const dynamicName: string;
// @ts-expect-error string is not assignable to a registered ExtensionName
extensions.use(dynamicName);
