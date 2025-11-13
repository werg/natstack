# NatStack Panel System - Design Document

## Overview

NatStack is an agentic platform for on-the-fly generative UI applications built on Electron. At its core is a sophisticated stackable panel system that allows dynamic, tree-based navigation with automatic layout management.

## Core Concept

The panel system implements a **horizontal stack** of panels where:
- Panels are arranged **left-to-right**
- Each panel can launch **child panels**
- Panels form a logical **tree structure** (parent-child relationships)
- Only one **path through the tree** is visible at a time (the "active path")
- Panels automatically **collapse** to maintain a user-defined maximum visible panel count

## Architecture

### 1. Data Structure (Panel Tree)

**File**: `src/renderer/state/PanelTree.ts`

The panel tree is a hierarchical structure where:
- Each node represents a panel
- Nodes have: `id`, `title`, `parentId`, `children[]`, `content`, `metadata`
- The tree always has a **root panel**
- Panels can have multiple children (creating branches)

**Key Operations**:
- `addChild(parentId, title)` - Create a new child panel
- `removePanel(id)` - Delete a panel and all descendants
- `getPathToPanel(id)` - Get the path from root to a panel
- `getAncestors(id)` - Get all parent panels
- `getDescendants(id)` - Get all child panels

### 2. State Management

**File**: `src/renderer/state/panelAtoms.ts`

Global state is modelled with Jotai atoms so React renders only the parts of the UI that actually change:

- `panelTreeAtom` – immutable snapshot of the tree (root node + `Map` of `PanelNode`s).
- `targetPanelAtom` – the panel that should anchor the visible path. Changing it automatically recomputes the path via `activePathAtom`.
- `panelColumnCountAtom` – user-configurable limit of simultaneous columns.
- `panelVisibilityStateAtom` – map of `PanelId → { visible, hiddenBecause }`. This is the persisted record of which parts of the active path were visible previously.
- `panelLayoutAtom` – derived description used by the renderer (`columns`, breadcrumbs, sibling tabs, child slivers, etc.).

Actions exported from the same module (`launchChildAtom`, `closePanelAtom`, `navigateToAtom`, `selectSiblingAtom`, `adjustColumnCountAtom`) mutate the atoms in response to UI events. Because these actions only replace the pieces of state that changed, React + Jotai automatically re-render the affected panels while leaving the rest of the tree untouched.

### 3. Layout Engine

**Files**: `src/renderer/state/panelVisibility.ts`, `src/renderer/state/panelAtoms.ts`

`reconcileVisibilityState()` is the new layout algorithm. It consumes four inputs—the active path, the requested column budget, the target panel, and the previous visibility map—and produces a stable sliding window of visible panels. The function:

1. Clamps the column budget (minimum 1) and reuses the previous leftmost visible panel when possible so that the UI does not jump around.
2. Forces the target panel into the window, shifting the window only as much as necessary.
3. Writes a `Map<PanelId, PanelVisibilityRecord>` describing whether each panel on the path is visible or overflow-hidden. This map is persisted in Jotai, satisfying the requirement that hide/show decisions consider previous state.

`panelLayoutAtom` combines that visibility map with the tree to produce a `PanelLayoutDescription`:

- `columns`: ordered descriptors with node metadata, width allocations, and tab collections.
- `visiblePanelIds`: ids currently rendered as columns.
- `hiddenPanels`: ids that are reachable but hidden because they fell outside the active window.

Tabs now follow three concrete rules:

1. **Sibling tabs** – whenever a parent has multiple children, tabs appear directly above the visible child panel so users can flip between alternatives in-place.
2. **Breadcrumb tabs** – when ancestors are hidden (because the window slid past them), their tabs appear above the descendant panel, acting as breadcrumb navigation.
3. **Child sliver tabs** – if a panel’s children are all hidden, a compact tab bar appears at the bottom of the parent to keep those children reachable.

All tab sets are generated inside the layout atom so React components stay dumb renderers.

### 4. UI Components

#### React component tree

- **`PanelApp` (`src/renderer/components/PanelApp.tsx`)** – top-level React component. Mounts the control bar, panel stack, and a hook that keeps the visibility atom in sync with the latest path/column settings.
- **`ControlBar`** – exposes column count controls and basic status (how many nodes are visible vs. total path length).
- **`PanelStack` + `PanelColumn`** – render the horizontal stack. Each `PanelColumn` receives a descriptor from `panelLayoutAtom`, so it simply wires up buttons (`Launch Child`, `Close`) and injects the correct tab bars above/below its content.
- **`TabBar`** – lightweight presenter used for breadcrumb tabs, sibling selectors, and child slivers. Styling is handled in CSS without prescribing hardcoded tokens in the design doc.

UI interactions (button clicks, tab selection) call the action atoms described earlier, so React only concerns itself with rendering and event wiring.

## Interaction Patterns

### 1. Spawning New Contexts

When an agent or application needs to spawn a new context (such as launching a visualization tool, opening a detail view, or creating a subsidiary workspace):

**Flow**:
1. Create new child panel in tree hierarchy
2. Update active path to include the new context
3. Mark new context as active child of parent
4. If exceeds max visible panels, auto-collapse ancestor contexts
5. New context receives focus

**Use Cases**:
- An agent spawns a data visualization from a query result
- A code editor opens a related file for comparison
- A workflow triggers a detail inspector for an item
- A generative UI creates a new interactive widget

### 2. Switching Between Alternative Contexts

When multiple alternative contexts exist at the same level (e.g., different views of the same data, alternative agent outputs, or parallel workflows):

**Flow**:
1. Switch active child for parent context
2. Rebuild active path through new branch
3. Hide previous context and its descendants
4. Show new context with any active descendants

**Use Cases**:
- Switching between different visualizations of the same dataset
- Toggling between alternative agent-generated solutions
- Comparing different file versions or branches
- Switching between chat threads or conversation contexts

### 3. Navigating Up the Hierarchy

When users need to return to ancestor contexts (backtracking through their work):

**Flow**:
1. Truncate active path at selected ancestor
2. Hide all descendant contexts
3. Expand and focus the ancestor context
4. Update layout to reveal the context

**Use Cases**:
- Returning to a previous step in a multi-step workflow
- Navigating back to see the source that spawned current views
- Reviewing the context that led to current state
- Breadcrumb-style navigation through nested tools

### 4. Managing Screen Real Estate

Users can manually control how much space each context receives:

**Flow**:
1. Toggle individual panels between collapsed/expanded states
2. Recalculate layout to redistribute space
3. Collapsed panels show as thin tab strips

**Use Cases**:
- Temporarily hiding contexts to focus on others
- Keeping ancestor contexts visible for reference
- Maximizing space for detailed work
- Maintaining awareness of overall context tree

### 5. Closing Contexts

When contexts are no longer needed, they can be removed along with any nested descendants:

**Flow**:
1. Remove panel and all descendants from tree
2. Select alternative sibling if available
3. Rebuild active path excluding closed context
4. Clean up resources and state

**Use Cases**:
- Closing completed sub-tasks
- Removing outdated or incorrect agent outputs
- Cleaning up workspace clutter
- Ending specific workflows or sessions

### 6. Adapting Display Density

Users can adjust how many contexts are simultaneously visible:

**Flow**:
1. Update maximum visible panel count
2. Recalculate layout with new constraints
3. Auto-collapse or expand panels to meet limit

**Use Cases**:
- Working on ultrawide monitors (more panels visible)
- Working on smaller screens (fewer panels visible)
- Focusing deeply (reduce visible panels)
- Maintaining broad context awareness (increase visible panels)

## Layout Rules
0%

### Auto-Collapse Priority

When `activePath.length > maxVisiblePanels`:
- Keep **rightmost (deepest)** panels expanded
- Collapse **leftmost (ancestor)** panels first
- Algorithm: `expandablePanels.slice(-maxVisiblePanels)`

### Tab Strip Positioning

**Top (Breadcrumbs)**:
- Shows collapsed ancestor panels
- Positioned above first expanded panel
- Left offset = sum of collapsed panel widths before first expanded

**Bottom (Siblings)**:
- Shows inactive siblings of panels in active path
- Spans full width at bottom
- Allows switching between branches

## Visual Design System

### Design Tokens (`src/renderer/styles.css`)

**Colors**:
- Neutral palette: `--color-gray-50` through `--color-gray-900`
- Primary: `--color-primary` (#3b82f6 blue)
- Semantic: `--color-background`, `--color-surface`, `--color-border`

**Spacing**: 8px scale (`--space-1` through `--space-12`)

**Transitions**:
- Fast: 150ms (hover effects)
- Base: 250ms (state changes)
- Panel: 400ms (collapse/expand animations)

**Easing**: `cubic-bezier(0.4, 0, 0.2, 1)` for smooth motion

### Component Styling

**Panels**:
- Subtle borders
- Smooth width transitions
- Focused panels have blue inset shadow
- Collapsed panels show only header

**Tabs**:
- Rounded corners
- Hover: slight lift with shadow
- Active: primary blue background
- Transitions on all interactions

**Buttons**:
- Ghost: transparent with hover
- All have hover lift effect

## State Flow Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     User Action                         │
│ (launch child / pick tab / navigate / close)            │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│         Jotai action atoms (panelAtoms.ts)              │
│  • mutate panelTreeAtom                                 │
│  • move targetPanelAtom                                 │
│  • tweak column count                                   │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│         Atom graph recalculates derived state           │
│  • activePathAtom                                       │
│  • panelVisibilityStateAtom                             │
│  • panelLayoutAtom                                      │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│   reconcileVisibilityState + layout builder             │
│  • keep prior window when possible                      │
│  • generate breadcrumb / sibling / child tabs           │
│  • assign widths                                        │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│            React components (PanelApp tree)             │
│  • Control bar reflects settings                        │
│  • PanelColumn renders tabs + content                   │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                    DOM Update                           │
│  • Columns animate width                                │
│  • Tab bars move with their panels                      │
└─────────────────────────────────────────────────────────┘
```

## Vision & Capabilities

### Agentic Platform Foundation

NatStack is designed as a platform where autonomous agents can dynamically generate, compose, and manipulate user interfaces. The panel system provides the spatial and navigational framework for this:

**Dynamic Content Generation**:
- Agents compile and execute UI code on-the-fly using esbuild
- Each panel can host TypeScript, React, Vue, or other framework code
- Hot module reloading enables live updates as agents refine outputs
- Dependency bundling happens transparently

**Recursive Composition**:
- Any panel can spawn additional panels programmatically
- Panels can be webviews, iframes, or native components
- Child panels inherit context but run in sandboxed environments
- Agents can create deeply nested tool chains

**Inter-Panel Communication**:
- Parent-child messaging via IPC channels
- Shared state management across panel hierarchies
- Event systems for coordination between contexts
- Agents can orchestrate multi-panel workflows

**Lifecycle Management**:
- Panels have mount/unmount hooks for resource management
- State persistence across navigation and collapse/expand
- Automatic cleanup when contexts are closed
- Resource isolation prevents interference

### Extensibility & Customization

**Enhanced Navigation**:
- Drag-to-reorder sibling tabs for custom prioritization
- Panel splitting (horizontal/vertical) for side-by-side views
- Detach panels into floating windows for multi-monitor setups
- Browser-style back/forward history through context trees
- Keyboard shortcuts for power users

**Workspace Management**:
- Save/load panel layouts as templates
- Quick-launch predefined workflows
- Bookmark specific context paths
- Session persistence and restoration

**Visual Customization**:
- Theme system supporting dark mode and custom schemes
- Per-panel or per-app theming
- Adaptive layouts for different screen sizes
- Accessibility features (high contrast, reduced motion)

## Performance Considerations

**Optimizations**:
- Panels removed from active path are hidden (not destroyed)
- Layout calculations are O(n) where n = active path length
- Width transitions use CSS (GPU accelerated)
- Event delegation for tab clicks
- Virtual scrolling for many siblings (future)

**Constraints**:
- Recommended max panels in tree: ~1000
- Recommended max visible panels: 6
- Recommended max siblings per parent: ~20

## Development Guide

### Adding a New Panel Type

1. Extend `PanelContentData` type in `panel.types.ts`
2. Add the rendering logic to `PanelColumn.tsx` (or compose a dedicated React component and mount it there)
3. If the new panel type needs extra layout/state, add atoms or selectors in `panelAtoms.ts`
4. Add or tweak styling in `styles.css`

### Adding a New State Method

1. Create a new atom or action in `panelAtoms.ts`
2. Update `panelLayoutAtom` (or supporting selectors) if the derived data should change
3. Document the new state surface in this design doc
4. Wire the relevant UI control to the action atom inside the React components

### Testing Scenarios

**Core Navigation**:
- Spawn multiple child contexts from a single parent
- Switch between alternative sibling contexts via tabs
- Navigate back to ancestor contexts using breadcrumbs
- Close contexts at various tree depths
- Adjust maximum visible panel count dynamically

**Scalability**:
- Deep hierarchies (5+ levels of nesting)
- Wide branching (10+ sibling alternatives)
- Mixed scenarios (deep + wide)
- Window resizing and responsive behavior
- Performance with large context trees (~1000 panels)

## File Structure Summary

```
src/renderer/
├── types/
│   └── panel.types.ts           # TypeScript interfaces
├── state/
│   ├── PanelTree.ts            # Tree helper utilities
│   ├── panelAtoms.ts           # Jotai atoms + actions + layout derivations
│   └── panelVisibility.ts      # Visibility reconciliation algorithm
├── components/
│   ├── PanelApp.tsx            # Root React tree + sync hook
│   ├── ControlBar.tsx          # Column controls and status
│   ├── PanelStack.tsx          # Container for horizontal panels
│   ├── PanelColumn.tsx         # Individual column renderer
│   └── TabBar.tsx              # Breadcrumb / sibling / child tabs
├── index.ts                    # React renderer bootstrap
├── index.html                  # HTML shell
└── styles.css                  # Design system + layout styles
```

## Use Case Examples

### Example 1: AI-Powered Data Analysis Workflow

1. **Root Panel**: User starts with a data query interface
2. **Query Results**: Agent spawns a child panel showing tabular results
3. **Visualization**: From results, agent spawns a chart visualization
4. **Detail Inspector**: User clicks a data point, spawning a detail view
5. **Alternative Views**: Agent generates 3 alternative visualization types as sibling tabs
6. **Editing**: User spawns an editor panel to modify the query

Navigation: User can keep results and chart visible side-by-side, and use tabs to switch between alternative visualizations. Breadcrumbs allow quick return to the root query.

### Example 2: Collaborative Code Review

1. **Root Panel**: File tree browser
2. **File View**: Developer opens a source file
3. **Related Files**: Agent suggests and spawns related files as siblings
4. **Diff View**: Opening a PR spawns a diff visualization
5. **Comment Thread**: Clicking a comment spawns a discussion panel
6. **AI Assistant**: Agent spawns a code analysis tool alongside the file

Navigation: Developers can switch between related files via tabs, keep diff visible while reading comments, and collapse the file tree when focusing on specific discussions.

### Example 3: Generative UI Design System

1. **Root Panel**: Component library browser
2. **Component Viewer**: Selecting a component spawns a live preview
3. **Variants**: Agent generates component variants as sibling tabs
4. **Code View**: Spawns the component's source code in a child panel
5. **Documentation**: Agent generates interactive docs in a sibling panel
6. **Usage Examples**: Agent spawns example implementations

Navigation: Designers can compare variants side-by-side, quickly switch between code and docs, and maintain breadcrumb access to the component library while exploring deep into implementation details.

## Conclusion

The NatStack panel system provides a robust, extensible foundation for building dynamic, agentic UI applications. Its tree-based navigation model with automatic layout management creates an intuitive user experience while maintaining clean architectural separation between state, layout, and presentation concerns.

The system is designed to support autonomous agents that can programmatically generate, compose, and orchestrate user interfaces, enabling a new paradigm of adaptive, context-aware applications that evolve with user needs and agent capabilities.
