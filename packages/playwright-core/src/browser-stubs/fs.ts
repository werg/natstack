// Startup validation for OPFS fs
if (!(globalThis as any).fs) {
  throw new Error('Missing required: globalThis.fs (OPFS) - Playwright requires OPFS-based fs for browser operation');
}

const injectedFs = (globalThis as any).fs;

const fs = {
  readFile: injectedFs.readFile?.bind(injectedFs),
  writeFile: injectedFs.writeFile?.bind(injectedFs),
  rm: injectedFs.rm?.bind(injectedFs),
  existsSync: injectedFs.existsSync?.bind(injectedFs),
};

export default fs;
export const readFile = fs.readFile;
export const writeFile = fs.writeFile;
export const rm = fs.rm;
export const existsSync = fs.existsSync;
