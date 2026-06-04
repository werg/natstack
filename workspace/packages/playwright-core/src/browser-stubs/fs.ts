const unavailable = () => {
  throw new Error("Node fs is not available in workspace Playwright browser builds");
};

export const promises = new Proxy({}, { get: () => unavailable });
export const readFile = unavailable;
export const writeFile = unavailable;
export const readdir = unavailable;
export const stat = unavailable;
export const lstat = unavailable;
export const mkdir = unavailable;
export const rmdir = unavailable;
export const unlink = unavailable;
export const rename = unavailable;
export const copyFile = unavailable;
export const access = unavailable;
export const appendFile = unavailable;
export const chmod = unavailable;
export const chown = unavailable;
export const symlink = unavailable;
export const readlink = unavailable;
export const realpath = unavailable;
export const truncate = unavailable;
export const utimes = unavailable;
export const rm = unavailable;
export const open = unavailable;
export const link = unavailable;
export const mkdtemp = unavailable;
export const watch = unavailable;
export const cp = unavailable;
export const constants = {};
export const existsSync = unavailable;
export const readFileSync = unavailable;
export const writeFileSync = unavailable;
export const readdirSync = unavailable;
export const statSync = unavailable;
export const lstatSync = unavailable;
export const mkdirSync = unavailable;
export const rmSync = unavailable;
export const realpathSync = unavailable;

export default {
  promises,
  readFile,
  writeFile,
  readdir,
  stat,
  lstat,
  mkdir,
  rmdir,
  unlink,
  rename,
  copyFile,
  access,
  appendFile,
  chmod,
  chown,
  symlink,
  readlink,
  realpath,
  truncate,
  utimes,
  rm,
  open,
  link,
  mkdtemp,
  watch,
  cp,
  constants,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  lstatSync,
  mkdirSync,
  rmSync,
  realpathSync,
};
