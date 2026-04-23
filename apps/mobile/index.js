// Polyfill process.cwd for path-browserify and other Node.js compat code
if (typeof process !== "undefined" && !process.cwd) {
  process.cwd = () => "/";
}

import { AppRegistry } from "react-native";
import App from "./App";
import { name as appName } from "./app.json";

AppRegistry.registerComponent(appName, () => App);
