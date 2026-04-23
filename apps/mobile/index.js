// Polyfill process.cwd for path-browserify and other Node.js compat code
if (typeof process !== "undefined" && !process.cwd) {
  process.cwd = () => "/";
}

// Polyfill globalThis.crypto.getRandomValues — used by the node:crypto shim
// (src/nodeShims/crypto.ts) and by any workspace code that reaches for web
// crypto. Must load before anything that may call crypto.randomBytes.
import "react-native-get-random-values";
// Polyfill WHATWG URL / URLSearchParams — Hermes ships an incomplete URL
// implementation (no .hostname, no .searchParams.*). Must be early import so
// workspace code that `new URL(...)` runs through the polyfill.
import "react-native-url-polyfill/auto";
import { AppRegistry } from "react-native";
import App from "./App";
import { name as appName } from "./app.json";

AppRegistry.registerComponent(appName, () => App);
