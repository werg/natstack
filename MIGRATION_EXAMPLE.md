# Migration Example: Converting to New Hooks API

This document shows a real before/after example of migrating a panel to the new hooks-based API.

## Example: Agentic Chat Panel

### Before (Old API)

```tsx
// panels/agentic-chat/index.tsx (OLD)
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createReactPanelMount } from "natstack/react";
import { models, getAvailableModels, type AIModelInfo } from "natstack/ai";
import { Theme, Box, Flex, Card, Text, Heading, Button, TextArea, Select, Callout, Separator } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";

type ChatTurn = { role: "user" | "assistant"; text: string; pending?: boolean };
type PromptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: Array<{ type: "text"; text: string }> }
  | { role: "assistant"; content: Array<{ type: "text"; text: string }> };

const mount = createReactPanelMount(React, createRoot, { ThemeComponent: Theme });

function App() {
  const [availableModels, setAvailableModels] = useState<AIModelInfo[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string>("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const modelsList = await getAvailableModels();
        setAvailableModels(modelsList);
        if (!modelId && modelsList.length > 0) {
          setModelId(modelsList[0].id);
        }
      } catch (error) {
        setStatus(`Failed to load models: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, [modelId]);

  // ... rest of component logic ...

  return (
    <Box p="4" style={{ height: "100%" }}>
      {/* ... UI ... */}
    </Box>
  );
}

mount(App);
```

### After (New Hooks API)

```tsx
// panels/agentic-chat/index.tsx (NEW)
import { useEffect, useMemo, useRef, useState } from "react";
import { models, getAvailableModels, type AIModelInfo } from "natstack/ai";
import { Box, Flex, Card, Text, Heading, Button, TextArea, Select, Callout, Separator } from "@radix-ui/themes";

type ChatTurn = { role: "user" | "assistant"; text: string; pending?: boolean };
type PromptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: Array<{ type: "text"; text: string }> }
  | { role: "assistant"; content: Array<{ type: "text"; text: string }> };

export default function AgenticChat() {
  const [availableModels, setAvailableModels] = useState<AIModelInfo[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string>("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const modelsList = await getAvailableModels();
        setAvailableModels(modelsList);
        if (!modelId && modelsList.length > 0) {
          setModelId(modelsList[0].id);
        }
      } catch (error) {
        setStatus(`Failed to load models: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, [modelId]);

  // ... rest of component logic ...

  return (
    <Box p="4" style={{ height: "100%" }}>
      {/* ... UI ... */}
    </Box>
  );
}
```

### Changes Made

1. **Removed imports:**
   - ❌ `import React from "react"`
   - ❌ `import { createRoot } from "react-dom/client"`
   - ❌ `import { createReactPanelMount } from "natstack/react"`
   - ❌ `import { Theme } from "@radix-ui/themes"`
   - ❌ `import "@radix-ui/themes/styles.css"`

2. **Removed mount code:**
   - ❌ `const mount = createReactPanelMount(React, createRoot, { ThemeComponent: Theme });`
   - ❌ `mount(App);`

3. **Changed export:**
   - ❌ `function App() {`
   - ✅ `export default function AgenticChat() {`

4. **Kept everything else the same:**
   - Component logic unchanged
   - State management unchanged
   - UI code unchanged

### Line Count Comparison

- **Before:** 212 lines
- **After:** 204 lines (removing the 8 lines of boilerplate)
- **Reduction:** 3.8% (but 100% reduction in boilerplate)

---

## Example: Simple Panel Using Hooks

Here's how to use the new hooks for common tasks:

### Getting Theme

**Before:**
```tsx
import { useState, useEffect } from "react";
import panelAPI from "natstack/react";

function MyPanel() {
  const [theme, setTheme] = useState(panelAPI.getTheme());

  useEffect(() => {
    const unsubscribe = panelAPI.onThemeChange(setTheme);
    return unsubscribe;
  }, []);

  return <div>{theme.appearance}</div>;
}
```

**After:**
```tsx
import { usePanelTheme } from "natstack/react";

export default function MyPanel() {
  const theme = usePanelTheme();
  return <div>{theme.appearance}</div>;
}
```

### Managing Child Panels

**Before:**
```tsx
import { useState, useEffect } from "react";
import panelAPI from "natstack/react";

function MyPanel() {
  const [children, setChildren] = useState<string[]>([]);

  const handleAddChild = async () => {
    const childId = await panelAPI.createChild("panels/example");
    setChildren(prev => [...prev, childId]);
  };

  const handleRemoveChild = async (childId: string) => {
    await panelAPI.removeChild(childId);
    setChildren(prev => prev.filter(id => id !== childId));
  };

  useEffect(() => {
    const unsubscribe = panelAPI.onChildRemoved((childId) => {
      setChildren(prev => prev.filter(id => id !== childId));
    });
    return unsubscribe;
  }, []);

  return (
    <div>
      <button onClick={handleAddChild}>Add Child</button>
      {children.map(childId => (
        <div key={childId}>
          {childId}
          <button onClick={() => handleRemoveChild(childId)}>Remove</button>
        </div>
      ))}
    </div>
  );
}
```

**After:**
```tsx
import { useChildPanels } from "natstack/react";

export default function MyPanel() {
  const { children, createChild, removeChild } = useChildPanels();

  return (
    <div>
      <button onClick={() => createChild("panels/example")}>Add Child</button>
      {children.map(childId => (
        <div key={childId}>
          {childId}
          <button onClick={() => removeChild(childId)}>Remove</button>
        </div>
      ))}
    </div>
  );
}
```

### Using RPC with Types

**Before:**
```tsx
import { useState, useEffect } from "react";
import panelAPI from "natstack/react";
import type { ChildAPI } from "./types";

function MyPanel() {
  const [childId, setChildId] = useState<string | null>(null);
  const [handle, setHandle] = useState(null);

  useEffect(() => {
    if (childId) {
      setHandle(panelAPI.rpc.getHandle<ChildAPI>(childId));
    }
  }, [childId]);

  const handleCall = async () => {
    if (handle) {
      await handle.call.someMethod();
    }
  };

  useEffect(() => {
    if (!handle) return;
    const unsubscribe = handle.on("some-event", (payload) => {
      console.log(payload);
    });
    return unsubscribe;
  }, [handle]);

  return <button onClick={handleCall}>Call Method</button>;
}
```

**After:**
```tsx
import { useState, useEffect } from "react";
import { usePanelRpc } from "natstack/react";
import type { ChildAPI, ChildEvents } from "./types";

export default function MyPanel() {
  const [childId, setChildId] = useState<string | null>(null);
  const handle = usePanelRpc<ChildAPI, ChildEvents>(childId);

  useEffect(() => {
    if (!handle) return;
    return handle.on("some-event", (payload) => {
      console.log(payload); // Fully typed!
    });
  }, [handle]);

  const handleCall = async () => {
    if (handle) {
      await handle.call.someMethod(); // Fully typed!
    }
  };

  return <button onClick={handleCall}>Call Method</button>;
}
```

---

## Migration Checklist

When migrating a panel to the new API:

- [ ] Remove `import React from "react"` (only need named imports)
- [ ] Remove `import { createRoot } from "react-dom/client"`
- [ ] Remove `import { createReactPanelMount } from "natstack/react"`
- [ ] Remove `import { Theme } from "@radix-ui/themes"`
- [ ] Remove `import "@radix-ui/themes/styles.css"`
- [ ] Remove `const mount = createReactPanelMount(...)`
- [ ] Remove `mount(Component)` at the end
- [ ] Change `function Component()` to `export default function Component()`
- [ ] Replace `panelAPI.getTheme() + useEffect` with `usePanelTheme()`
- [ ] Replace manual child management with `useChildPanels()`
- [ ] Replace manual RPC handle creation with `usePanelRpc()`
- [ ] Add type parameters to RPC hooks for type safety
- [ ] Import hooks from `"natstack/react"` as needed

---

## Backward Compatibility

The old API still works! You don't have to migrate immediately:

```tsx
// This still works fine
import React from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import panelAPI, { createReactPanelMount } from "natstack/react";
import "@radix-ui/themes/styles.css";

const mount = createReactPanelMount(React, createRoot, { ThemeComponent: Theme });

function OldStylePanel() {
  return <div>Still works!</div>;
}

mount(OldStylePanel);
```

But new panels should use the hooks API for better DX and less code.

---

## Tips for Migration

1. **Start with the boilerplate** - Remove imports and mount code first
2. **Replace component name** - Change to default export
3. **Identify patterns** - Look for `panelAPI.*` calls and `useEffect` subscriptions
4. **Replace with hooks** - Use the appropriate hook for each pattern
5. **Test thoroughly** - Make sure events and subscriptions still work
6. **Add types** - Use typed RPC handles for better type safety

---

## Need Help?

See the full documentation:
- [PANEL_DEVELOPMENT.md](PANEL_DEVELOPMENT.md) - Complete guide
- [IMPROVEMENTS.md](IMPROVEMENTS.md) - What's new
- Example panels in `panels/simple-example/` and `panels/typed-rpc-*/`
