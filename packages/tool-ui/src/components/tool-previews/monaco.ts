/**
 * Monaco-dependent Tool Preview Components
 *
 * These components require Monaco for syntax-highlighted code previews.
 * Import from this module only when you need these specific components.
 *
 * Uses modern-monaco via @natstack/git-ui/monaco for lightweight bundling (~3-4MB).
 */

export { FileEditPreview, type FileEditPreviewProps } from "./FileEditPreview.js";
export { FileWritePreview, type FileWritePreviewProps } from "./FileWritePreview.js";
