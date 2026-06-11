import "react-native-get-random-values";
import "react-native-url-polyfill/auto";

type ProcessGlobal = {
  env?: Record<string, string | undefined>;
  cwd?: () => string;
};

const existingProcess = globalThis.process as ProcessGlobal | undefined;
const processGlobal: ProcessGlobal = existingProcess ?? {};

processGlobal.env ??= {};
processGlobal.cwd ??= () => "/";

if (!existingProcess) {
  Object.defineProperty(globalThis, "process", {
    configurable: true,
    value: processGlobal,
  });
}

function randomUUID(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

if (globalThis.crypto && typeof globalThis.crypto.randomUUID !== "function") {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: randomUUID,
  });
}
