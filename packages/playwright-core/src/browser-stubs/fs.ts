const injectedFs = (globalThis as any).fs;
const notAvailable = () => {
  throw new Error('fs is not available in the browser bundle');
};

const fs = injectedFs ?? {
  readFile: notAvailable,
  writeFile: notAvailable,
  rm: notAvailable,
  existsSync: () => false,
};

export default fs;
export const readFile = fs.readFile?.bind(fs) ?? notAvailable;
export const writeFile = fs.writeFile?.bind(fs) ?? notAvailable;
export const rm = fs.rm?.bind(fs) ?? notAvailable;
export const existsSync = fs.existsSync?.bind(fs) ?? (() => false);
