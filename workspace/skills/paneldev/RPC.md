# Typed RPC Contracts

Type-safe parent-child communication using contracts.

## Define Contract

```typescript
// panels/editor/contract.ts
import { z, defineContract } from "@natstack/runtime";

export interface EditorApi {
  getContent(): Promise<string>;
  setContent(text: string): Promise<void>;
  save(): Promise<void>;
}

export const editorContract = defineContract({
  source: "panels/editor",
  child: {
    methods: {} as EditorApi,
    emits: {
      "saved": z.object({ path: z.string(), timestamp: z.number() }),
      "modified": z.object({ dirty: z.boolean() }),
    },
  },
});
```

## Export Contract

```json
{
  "name": "@workspace-panels/editor",
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts"
  }
}
```

## Implement Child

```tsx
import { useEffect, useState } from "react";
import { rpc, getParentWithContract, noopParent } from "@natstack/runtime";
import { editorContract } from "./contract.js";

const parent = getParentWithContract(editorContract) ?? noopParent;

export default function Editor() {
  const [content, setContent] = useState("");

  useEffect(() => {
    rpc.expose({
      async getContent() { return content; },
      async setContent(text) { setContent(text); },
      async save() {
        parent.emit("saved", { path: "/file.txt", timestamp: Date.now() });
      },
    });
  }, [content]);

  return (
    <textarea
      value={content}
      onChange={e => {
        setContent(e.target.value);
        parent.emit("modified", { dirty: true });
      }}
    />
  );
}
```

## Use from Parent

```tsx
import { useState, useEffect } from "react";
import { createChildWithContract } from "@natstack/runtime";
import { editorContract } from "@workspace-panels/editor/contract";

export default function IDE() {
  const [editor, setEditor] = useState(null);

  const launch = async () => {
    const child = await createChildWithContract(editorContract, { name: "editor" });
    setEditor(child);
  };

  useEffect(() => {
    if (!editor) return;
    const unsub1 = editor.onEvent("saved", ({ path }) => console.log("Saved:", path));
    const unsub2 = editor.onEvent("modified", ({ dirty }) => console.log("Dirty:", dirty));
    return () => { unsub1(); unsub2(); };
  }, [editor]);

  return (
    <div>
      <button onClick={launch}>Open Editor</button>
      {editor && <button onClick={() => editor.call.save()}>Save</button>}
    </div>
  );
}
```

## ChildHandle Methods

```typescript
child.id                          // Unique ID
child.name                        // Name from creation
child.type                        // "app" | "worker" | "browser"
child.source                      // Panel path or URL

child.call.method(args)           // Call exposed RPC method
child.onEvent("event", handler)   // Listen for events
child.emit("event", payload)      // Emit event to child
child.close()                     // Close the panel
```

## ParentHandle Methods

```typescript
parent.id                         // Parent's ID
parent.call.method(args)          // Call parent's RPC method
parent.emit("event", payload)     // Emit event to parent
parent.onEvent("event", handler)  // Listen for parent events
```
