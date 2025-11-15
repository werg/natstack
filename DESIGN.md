# NatStack Panel System - Design Document

## Overview

NatStack is an agentic platform for on-the-fly generative UI applications built on Electron. At its core is a simple stackable panel system that allows tree-based navigation with user-controlled layout management.

## Core Concept

The panel system implements a **horizontal stack** of panels where:
- Panels are arranged **left-to-right**
- Each panel can launch **child panels**
- Panels form a logical **tree structure** (parent-child relationships)
- Only one **path through the tree** is visible at a time (the "active path")
- Users **manually control** which panels are minimized via minimize buttons
- Panel widths are **equal by default**, but can be **resized by dragging** boundaries

## Architecture

### 1. Data Structure (Panel Tree)

**File**: [src/renderer/state/PanelTree.ts](src/renderer/state/PanelTree.ts)

The panel tree is a hierarchical structure where:
- Each node represents a panel
- Nodes have: `id`, `title`, `parentId`, `children[]`, `content`, `metadata`
- The tree always has a **root panel**
- Panels can have multiple children (creating branches)

**Key Operations**:
- `addChild(parentId, title)` - Create a new child panel
- `removePanel(id)` - Delete a panel and all descendants
- `getPathToPanel(id)` - Get the path from root to a panel

### 2. State Management

**File**: [src/renderer/state/panelAtoms.ts](src/renderer/state/panelAtoms.ts)

Global state is modeled with Jotai atoms so React renders only the parts of the UI that actually change:

**Core State Atoms:**
- `panelTreeAtom` – immutable snapshot of the tree (root node + `Map` of `PanelNode`s)
- `targetPanelAtom` – the panel that should be active/focused
- `panelVisibilityAtom` – `Map<PanelId, boolean>` where `true` = minimized, `false/undefined` = expanded
- `panelWidthsAtom` – `Map<PanelId, number>` storing custom widths in pixels (panels not in map get equal width)
- `activePathAtom` – derived atom computing the path from root to target panel

**Layout Atom:**
- `panelLayoutAtom` – derived atom that computes the complete layout description:
  - Maps each panel in active path to a column descriptor
  - Calculates width fractions (equal distribution or custom widths)
  - Determines which tabs appear where (top/bottom/siblings)
  - Checks minimized state for each panel

**Action Atoms:**
- `launchChildAtom` – create and navigate to a new child panel
- `closePanelAtom` – remove a panel and its descendants
- `navigateToAtom` – change the target panel
- `selectSiblingAtom` – switch between sibling panels
- `toggleMinimizeAtom` – toggle minimize state for a panel
- `setPanelWidthAtom` – set custom width for a panel

### 3. Layout Engine

**File**: [src/renderer/state/panelAtoms.ts](src/renderer/state/panelAtoms.ts)

The layout algorithm (`panelLayoutAtom`) is radically simple:

1. **Active Path**: All panels from root to target are included
2. **Width Calculation**:
   - If a panel has a custom width (in `panelWidthsAtom`), use it
   - Otherwise, divide available space equally among panels without custom widths
3. **Tab Placement**:
   - **Top tabs** (leftmost panel only): Show minimized ancestors as breadcrumbs
   - **Sibling tabs** (all panels): Show alternative children of the same parent
   - **Bottom tabs** (non-leftmost panels): Show minimized ancestors as breadcrumbs

No automatic hiding, no window sliding, no complex visibility reconciliation. The user controls everything via minimize buttons.

### 4. UI Components

#### React component tree

**File**: [src/renderer/components/PanelApp.tsx](src/renderer/components/PanelApp.tsx)

- **`PanelApp`** – top-level React component. Only handles theme synchronization now (no control bar)
- **`PanelStack`** – renders the horizontal stack of panels from `panelLayoutAtom`
- **`PanelColumn`** – renders a single panel with:
  - Top tabs (for leftmost panel: minimized ancestors)
  - Sibling tabs (if panel has siblings)
  - Header with title and action buttons (minimize, launch child, close)
  - Content area (hidden when minimized)
  - Bottom tabs (for non-leftmost panels: minimized ancestors)
  - Resize handle (right edge, hidden when minimized)
- **`TabBar`** – lightweight presenter for tab collections

**Minimization Logic:**
- Each panel has a minimize button (◀ to minimize)
- When minimized:
  - Panel is **completely hidden** (not rendered)
  - Panel only appears as a **breadcrumb tab** that can be clicked to restore it
- Minimized ancestors appear as breadcrumb tabs:
  - At **top** of leftmost visible panel
  - At **bottom** of all other visible panels
- Clicking a breadcrumb tab restores (un-minimizes) that panel and navigates to it

**Resizing Logic:**
- Each expanded panel has a resize handle on its right edge
- Dragging the handle updates `panelWidthsAtom` for that panel
- Custom widths persist until panel is closed
- Other panels without custom widths share remaining space equally

## Interaction Patterns

### 1. Spawning New Contexts

When an agent or application needs to spawn a new context:

**Flow**:
1. Call `launchChildAtom` with parent panel ID
2. New child panel is added to tree
3. Target panel updates to the new child
4. Active path automatically includes the new panel
5. All panels in path are visible (some may be minimized by user)

**Use Cases**:
- An agent spawns a data visualization from a query result
- A code editor opens a related file for comparison
- A generative UI creates a new interactive widget

### 2. Switching Between Alternative Contexts

When multiple alternative contexts exist at the same level:

**Flow**:
1. User clicks a sibling tab
2. `selectSiblingAtom` updates the target panel
3. Active path rebuilds through the new branch
4. Previous sibling's descendants are no longer in active path (thus hidden)

**Use Cases**:
- Switching between different visualizations of the same dataset
- Toggling between alternative agent-generated solutions
- Comparing different file versions

### 3. Managing Screen Real Estate

Users have full manual control over panel visibility:

**Flow**:
1. Click minimize button (◀) to hide a panel
2. `toggleMinimizeAtom` updates `panelVisibilityAtom`
3. Panel is completely hidden (not rendered)
4. Breadcrumb tab appears in descendant panels
5. Click breadcrumb tab to restore and navigate to the panel

**Benefits**:
- Simple, predictable behavior
- No automatic hiding surprises
- Users control their own workflow
- Clean interface - minimized panels don't take up space

### 4. Adjusting Panel Widths

Users can customize how much space each panel receives:

**Flow**:
1. Hover over panel boundary (right edge)
2. Resize handle appears
3. Drag left/right to adjust width
4. `setPanelWidthAtom` stores custom width
5. Other panels redistribute remaining space

**Use Cases**:
- Giving more space to detailed content
- Shrinking reference panels to small size
- Creating custom layout for specific workflow

### 5. Closing Contexts

When contexts are no longer needed:

**Flow**:
1. Click close button
2. `closePanelAtom` removes panel and descendants
3. If closed panel was in active path, target moves to parent
4. Visibility and width state cleaned up for removed panels

**Use Cases**:
- Closing completed sub-tasks
- Removing outdated agent outputs
- Cleaning up workspace

## Visual Design System

### Design Tokens

**File**: [src/renderer/styles.css](src/renderer/styles.css)

**Colors**:
- Neutral palette: `--color-gray-50` through `--color-gray-900`
- Primary: `--color-primary` (#3b82f6 blue)
- Semantic: `--color-background`, `--color-surface`, `--color-border`

**Panel Dimensions**:
- `--panel-min-width`: 200px (minimum width for expanded panels)
- `--panel-header-height`: 48px
- `--resize-handle-width`: 4px

**Transitions**:
- Fast: 150ms (hover effects)
- Base: 250ms (state changes)
- Panel: 400ms (minimize/expand animations)

### Component Styling

**Panels**:
- Default: flexible width (equal distribution or custom)
- Minimized: not rendered (only appear as breadcrumb tabs)
- Target (`.panel-target`): blue inset shadow
- Resize handle: 4px zone on right edge, becomes blue on hover

**Tabs**:
- Breadcrumbs at top: for leftmost panel only
- Sibling tabs: always at top of panel (below breadcrumbs if present)
- Breadcrumbs at bottom: for all non-leftmost panels
- Active tab: primary blue background
- Hover: slight lift with shadow

**Buttons**:
- Ghost style for panel actions
- Minimize button shows ◀ to hide the panel

## State Flow Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     User Action                         │
│ (launch/close/navigate/minimize/resize)                 │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│         Jotai action atoms (panelAtoms.ts)              │
│  • launchChildAtom / closePanelAtom                     │
│  • navigateToAtom / selectSiblingAtom                   │
│  • toggleMinimizeAtom                                   │
│  • setPanelWidthAtom                                    │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│         Atom graph recalculates derived state           │
│  • activePathAtom (root → target)                       │
│  • panelLayoutAtom (columns + tabs + widths)            │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│            React components (PanelApp tree)             │
│  • PanelColumn renders each panel in active path        │
│  • Apply minimized state (hide content, rotate header)  │
│  • Render tabs in correct positions                     │
│  • Attach resize handlers                               │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                    DOM Update                           │
│  • Panels animate width changes                         │
│  • Minimize transitions smooth                          │
│  • Tab bars appear/disappear                            │
└─────────────────────────────────────────────────────────┘
```

## Vision & Capabilities

### Agentic Platform Foundation

NatStack is designed as a platform where autonomous agents can dynamically generate, compose, and manipulate user interfaces:

**Dynamic Content Generation**:
- Agents compile and execute UI code on-the-fly using esbuild
- Each panel can host TypeScript, React, Vue, or other framework code
- Hot module reloading enables live updates as agents refine outputs

**Recursive Composition**:
- Any panel can spawn additional panels programmatically
- Panels can be webviews, iframes, or native components
- Child panels inherit context but run in sandboxed environments

**Inter-Panel Communication**:
- Parent-child messaging via IPC channels
- Shared state management across panel hierarchies
- Agents can orchestrate multi-panel workflows

**Lifecycle Management**:
- Panels have mount/unmount hooks for resource management
- State persistence for visibility and width preferences
- Automatic cleanup when contexts are closed

### Extensibility & Customization

**Enhanced Navigation**:
- Drag-to-reorder sibling tabs for custom prioritization
- Panel splitting (horizontal/vertical) for side-by-side views
- Detach panels into floating windows for multi-monitor setups
- Keyboard shortcuts for power users

**Workspace Management**:
- Save/load panel layouts as templates
- Quick-launch predefined workflows
- Session persistence and restoration

**Visual Customization**:
- Theme system supporting dark mode and custom schemes
- Adaptive layouts for different screen sizes
- Accessibility features (high contrast, reduced motion)

## Performance Considerations

**Optimizations**:
- Only panels in active path are rendered
- Layout calculations are O(n) where n = active path length
- Width transitions use CSS (GPU accelerated)
- Minimize state stored as simple boolean map

**Constraints**:
- Recommended max panels in tree: ~1000
- Recommended max visible panels in path: ~10
- Recommended max siblings per parent: ~20

## Development Guide

### Adding a New Panel Type

1. Extend `PanelContentData` type in [panel.types.ts](src/renderer/types/panel.types.ts)
2. Add rendering logic to [PanelColumn.tsx](src/renderer/components/PanelColumn.tsx)
3. Add styling in [styles.css](src/renderer/styles.css)

### Adding a New State Method

1. Create a new action atom in [panelAtoms.ts](src/renderer/state/panelAtoms.ts)
2. Update `panelLayoutAtom` if derived data should change
3. Wire UI control to the action atom in React components

### Testing Scenarios

**Core Navigation**:
- Spawn multiple child contexts from a single parent
- Switch between alternative sibling contexts via tabs
- Minimize/restore panels at various depths
- Resize panels and verify width persistence
- Close contexts at various tree depths

**Layout Management**:
- Minimize root panel, verify breadcrumbs at top of first visible panel
- Minimize middle panel, verify breadcrumbs at bottom of descendants
- Resize multiple panels, verify equal distribution of remaining space
- Mix custom widths and minimized panels

**Edge Cases**:
- Minimize all panels except leaf
- Close parent while child is target
- Resize during minimize animation
- Rapid minimize/restore toggling

## File Structure Summary

```
src/renderer/
├── types/
│   └── panel.types.ts           # TypeScript interfaces
├── state/
│   ├── PanelTree.ts             # Tree helper utilities
│   └── panelAtoms.ts            # Jotai atoms + actions + layout
├── components/
│   ├── PanelApp.tsx             # Root React component
│   ├── PanelStack.tsx           # Container for horizontal panels
│   ├── PanelColumn.tsx          # Individual panel with resize + minimize
│   └── TabBar.tsx               # Tab presenter
├── index.tsx                    # React renderer bootstrap
├── index.html                   # HTML shell
└── styles.css                   # Design system + layout styles
```

## Key Simplifications from Previous Design

1. **No automatic visibility reconciliation** – users control minimize state manually
2. **No column count limit** – all panels in active path are visible (minimized or expanded)
3. **No complex overflow logic** – just simple breadcrumb tabs for minimized ancestors
4. **No control bar** – UI is cleaner without global controls
5. **User-driven layout** – minimize and resize give users full control
6. **Simpler state** – just tree, path, visibility map, and width map
7. **Simpler tab rules**:
   - Leftmost panel: minimized ancestors at **top**
   - All panels: siblings at **top**
   - Non-leftmost panels: minimized ancestors at **bottom**

## Use Case Examples

### Example 1: AI-Powered Data Analysis Workflow

1. **Root Panel**: User starts with a data query interface
2. **Query Results**: Agent spawns a child panel showing tabular results
3. **Visualization**: From results, agent spawns a chart visualization
4. User **minimizes** query panel - it disappears, appears as breadcrumb tab
5. User **resizes** results panel to be smaller, giving more space to chart
6. **Detail Inspector**: User clicks a data point, spawning a detail view
7. User **minimizes** results panel - now only chart and detail view are visible
8. User can click breadcrumb tabs to restore any minimized panel

### Example 2: Collaborative Code Review

1. **Root Panel**: File tree browser
2. **File View**: Developer opens a source file
3. User **minimizes** file tree - it becomes a breadcrumb tab
4. **Diff View**: Opening a PR spawns a diff visualization
5. User **resizes** file view to 30% width, diff to 70%
6. **Comment Thread**: Clicking a comment spawns a discussion panel
7. User **minimizes** file view - now only diff and comments visible
8. Click file tree breadcrumb to restore and navigate back

### Example 3: Multi-Step Workflow

1. **Root**: Workflow dashboard
2. **Step 1**: Input form
3. User completes form, **minimizes** dashboard
4. **Step 2**: Processing view (active)
5. User **minimizes** Step 1 after completion
6. **Step 3**: Review panel spawns
7. Only Step 2 and Step 3 are visible; Steps 1 and dashboard are breadcrumb tabs
8. User can click any breadcrumb to jump back and restore that step
9. User adjusts widths of visible panels to focus on current work

## Conclusion

The simplified NatStack panel system provides an intuitive, user-controlled foundation for building dynamic, agentic UI applications. By removing automatic layout management and giving users manual control via minimize buttons and resize handles, the system becomes more predictable, simpler to implement, and easier to understand.

The tree-based navigation model remains intact, while the layout mechanism is now driven entirely by user actions rather than complex algorithms. This creates a better user experience and a cleaner codebase.
