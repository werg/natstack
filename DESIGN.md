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

**File**: `src/renderer/state/PanelState.ts`

Manages the global state of the panel system:

```typescript
interface PanelState {
  tree: PanelTree                       // The panel hierarchy
  activePath: PanelId[]                 // Currently visible path (root to leaf)
  activeChildMap: Map<PanelId, PanelId> // Which child is selected per parent
  collapsedPanels: Set<PanelId>        // Manually collapsed panels
  focusedPanel: PanelId | null         // Currently focused panel
  maxVisiblePanels: number             // User-controlled limit
}
```

**Key Methods**:
- `launchChild(parentId, title)` - Create and navigate to a new child
- `selectTab(parentId, childId)` - Switch to a different child branch
- `navigateToPanel(id)` - Navigate back to an ancestor panel
- `collapsePanel(id)` / `expandPanel(id)` - Manual collapse/expand
- `closePanel(id)` - Remove a panel from the tree

### 3. Layout Engine

**File**: `src/renderer/layout/LayoutEngine.ts`

Calculates which panels should be visible and how they should be displayed:

```typescript
interface LayoutState {
  visiblePanels: PanelId[]        // Panels to render
  expandedPanels: PanelId[]       // Panels shown expanded (not collapsed)
  tabEntries: TabEntry[]          // Unified breadcrumb + sibling tabs
  panelWidths: Map<PanelId, number> // Width percentages
}

interface TabEntry {
  id: PanelId
  kind: 'path' | 'sibling'
  parentId: PanelId | null
}
```

**Layout Logic**:
1. All panels in `activePath` are visible
2. If `activePath.length > maxVisiblePanels`, auto-collapse leftmost panels
3. Collapsed panels are accessible via tabs / breadcrumbs
4. Expanded panels split remaining width equally
5. A single tab bar shows breadcrumbs plus sibling tabs for inactive branches

### 4. UI Components

#### Panel Component (`src/renderer/components/Panel.ts`)

A Web Component representing a single panel:

```typescript
class Panel extends HTMLElement {
  - panelId: PanelId
  - visibility: 'expanded' | 'collapsing' | 'collapsed' | 'hidden'

  Methods:
  - setTitle(title)
  - setVisibility(visibility)
  - setWidth(widthPercent)
  - setFocused(focused)
  - collapse() / expand()
  - addActionButton(label, onClick)
}
```

**Structure**:
```
<app-panel>
  <div class="panel-header">
    <h2 class="panel-title">Panel Title</h2>
    <div class="panel-actions">
      [Action Buttons]
    </div>
  </div>
  <div class="panel-content">
    [Panel Content]
  </div>
</app-panel>
```

#### TabStrip Component (`src/renderer/components/TabStrip.ts`)

Manages tabs for collapsed panels or sibling selection:

```typescript
class TabStrip extends HTMLElement {
  - position: 'top' | 'bottom' | 'vertical'
  - tabs: Map<PanelId, HTMLElement>

  Methods:
  - addTab(data: {id, title, active})
  - removeTab(panelId)
  - setActiveTab(panelId)
  - setOnTabClick(handler)
}
```

#### PanelManager (`src/renderer/components/PanelManager.ts`)

The orchestrator that ties everything together:

```typescript
class PanelManager {
  - stateManager: PanelStateManager
  - layoutEngine: LayoutEngine
  - panels: Map<PanelId, Panel>
  - topTabStrip: TabStrip
  - bottomTabStrip: TabStrip

  Main Loop:
  1. State changes trigger re-render
  2. Calculate layout from current state
  3. Update panel visibility and widths
  4. Update tab strips
  5. Position tab strips dynamically
}
```

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
│  (Launch Child / Select Tab / Navigate / Close)        │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                 PanelStateManager                       │
│  • Update tree structure                                │
│  • Update activePath                                    │
│  • Update activeChildMap                                │
│  • Notify listeners                                     │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                   LayoutEngine                          │
│  • Calculate visible panels                             │
│  • Determine expanded vs collapsed                      │
│  • Generate tab lists                                   │
│  • Calculate widths                                     │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                  PanelManager                           │
│  • Update panel visibility                              │
│  • Update panel widths                                  │
│  • Update tab strips                                    │
│  • Position tab strips                                  │
│  • Reorder panels in DOM                                │
└─────────────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                  DOM Update                             │
│  • Panels slide/fade                                    │
│  • Widths animate smoothly                              │
│  • Tabs update                                          │
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
2. Create component in `src/renderer/components/`
3. Update `renderPanelContent()` in `PanelManager.ts`
4. Add styling to `styles.css`

### Adding a New State Method

1. Add method to `PanelStateManager`
2. Update state and notify listeners
3. Document in this design doc
4. Add UI trigger in `PanelManager`

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
│   ├── PanelTree.ts            # Tree data structure
│   └── PanelState.ts           # State management
├── layout/
│   └── LayoutEngine.ts         # Layout calculations
├── components/
│   ├── Panel.ts                # Panel Web Component
│   ├── TabStrip.ts             # TabStrip Web Component
│   └── PanelManager.ts         # Orchestrator
├── index.ts                     # Entry point
├── index.html                   # HTML shell
└── styles.css                   # Design system + styles
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
