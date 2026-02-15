/**
 * @natstack/git-ui/monaco - Monaco-dependent exports
 *
 * This module provides Monaco editor integration components and utilities.
 * Import from this subpath when you need Monaco functionality.
 *
 * Uses modern-monaco for:
 * - Automatic worker handling via blob URLs (no MonacoEnvironment setup)
 * - Shiki-based syntax highlighting (lighter than Monaco's language services)
 * - Built-in LSP providers for HTML, CSS, JS/TS, JSON
 */

// Monaco initialization utilities
export { getMonaco, isMonacoReady, getMonacoSync, type MonacoNamespace } from "./modernMonaco.js";

// React Editor component wrapper (replaces @monaco-editor/react)
export { MonacoEditor } from "./MonacoEditor.js";

// Monaco TypeScript type checking configuration
export {
  configureMonacoTypeCheck,
  addMonacoTypeDefinition,
  diagnosticsToMarkers,
  setDiagnosticsOnModel,
  type MonacoTypeCheckConfig,
  type MarkerData,
} from "./monacoTypeCheck.js";

// Monaco-dependent components
export { ThreeWayMergeEditor } from "./ThreeWayMergeEditor.js";
export { BlameView } from "./BlameView.js";
export { DiffEditorDirect } from "./DiffBlock/DiffEditorDirect.js";
export { MonacoErrorBoundary } from "./MonacoErrorBoundary.js";

// FileContentView uses Monaco Editor
export { FileContentView } from "./DiffBlock/FileContentView.js";
