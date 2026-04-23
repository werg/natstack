import "react-native-get-random-values";

export function randomBytes(size) {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return {
    toString(encoding) {
      if (encoding === "hex") {
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      }
      return String.fromCharCode(...bytes);
    },
  };
}
