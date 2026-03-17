import type * as Rpc from "./rpc.js";
import type { PanelContract, ParentHandle, EventSchemaMap } from "./types.js";
/**
 * Helper to define a panel contract with proper type inference.
 *
 * @example
 * ```ts
 * interface MyChildMethods {
 *   doSomething(): Promise<void>;
 * }
 *
 * export const myContract = defineContract({
 *   source: "panels/my-panel",
 *   child: {
 *     methods: {} as MyChildMethods,
 *     emits: {
 *       "done": z.object({ result: z.string() }),
 *     },
 *   },
 * });
 * ```
 */
export declare function defineContract<ChildMethods extends Rpc.ExposedMethods = {}, ChildEmits extends EventSchemaMap = {}, ParentMethods extends Rpc.ExposedMethods = {}, ParentEmits extends EventSchemaMap = {}>(contract: {
    source: string;
    child?: {
        methods?: ChildMethods;
        emits?: ChildEmits;
    };
    parent?: {
        methods?: ParentMethods;
        emits?: ParentEmits;
    };
}): PanelContract<ChildMethods, ChildEmits, ParentMethods, ParentEmits>;
/**
 * A no-op parent handle for when there's no parent.
 * Use with nullish coalescing to avoid repetitive null checks:
 *
 * @example
 * ```ts
 * const parent = panel.getParentWithContract(contract) ?? noopParent;
 * parent.emit("event", payload); // Safe - silently does nothing if no parent
 * ```
 */
export declare const noopParent: ParentHandle;
//# sourceMappingURL=defineContract.d.ts.map