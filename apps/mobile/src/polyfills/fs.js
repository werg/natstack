// Empty stub — mobile shell does not use filesystem APIs.
// These functions exist so Metro can resolve `import * as fs from "fs"`
// without crashing. Any accidental runtime call throws immediately.
const noop = () => {
  throw new Error("fs is not available in React Native");
};

export const readFileSync = noop;
export const writeFileSync = noop;
export const existsSync = () => false;
export const mkdirSync = noop;
export const readdirSync = () => [];
export const statSync = noop;
export const unlinkSync = noop;
export const promises = {
  readFile: noop,
  writeFile: noop,
  mkdir: noop,
  readdir: async () => [],
  stat: noop,
  unlink: noop,
};
export default { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, promises };
