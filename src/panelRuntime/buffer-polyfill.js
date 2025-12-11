/**
 * Buffer polyfill for browser environment.
 * This is injected by esbuild to make isomorphic-git work in the browser.
 */
import { Buffer } from "buffer";

// Make Buffer globally available for isomorphic-git
globalThis.Buffer = Buffer;
